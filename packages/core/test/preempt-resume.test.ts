import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  LaneQuotaSignal,
  type AttemptContext,
  type Lane,
  type LaneResponse,
} from '../src/adapters/types.js';
import { TypedEmitter } from '../src/events.js';
import {
  CONTINUE_INSTRUCTION,
  continuationRequest,
  isUsageHot,
  Router,
} from '../src/router/router.js';
import { MemoryProfileStore } from '../src/store/profile-store.js';
import { MemoryStateStore } from '../src/store/state-store.js';
import type {
  FailoverPolicy,
  IronEvent,
  LaneKind,
  Profile,
  QuotaSignal,
  StreamEvent,
  UnifiedRequest,
} from '../src/types.js';
import { MemoryVault } from '../src/vault/vault.js';

/**
 * What one call on a profile does:
 * - 'ok': start, "from <id>", finish
 * - { usage }: report a usage snapshot through ctx.reportUsage, then 'ok'
 * - { texts, cut }: start, the texts, then (with cut) a limit mid-stream
 * - { toolOpen }: start, some text, a tool call that never ends, then a limit
 * - a QuotaSignal: a limit before anything is streamed
 */
type Step =
  | 'ok'
  | { usage: number; resetInMs?: number }
  | { texts: string[]; cut?: boolean }
  | { toolOpen: true }
  | QuotaSignal;

/** Shared script + recorder for every scripted lane in a test. */
class Script {
  readonly calls: string[] = [];
  readonly requests: Array<{ profileId: string; req: UnifiedRequest }> = [];
  constructor(private readonly steps: Record<string, Step[]>) {}
  next(id: string): Step {
    const list = this.steps[id] ?? ['ok'];
    return list.length > 1 ? list.shift()! : list[0]!;
  }
}

const limit: QuotaSignal = { kind: 'rate-limit', source: 'status', message: 'limited' };

class ScriptedLane implements Lane {
  constructor(
    readonly kind: LaneKind,
    private readonly script: Script,
  ) {}

  private report(ctx: AttemptContext, step: Step): void {
    if (typeof step === 'object' && 'usage' in step) {
      const now = ctx.now();
      ctx.reportUsage({
        utilisation: step.usage,
        observedAt: new Date(now).toISOString(),
        ...(step.resetInMs !== undefined
          ? { resetAt: new Date(now + step.resetInMs).toISOString() }
          : {}),
      });
    }
  }

  async complete(req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse> {
    this.script.calls.push(ctx.profile.id);
    this.script.requests.push({ profileId: ctx.profile.id, req });
    const step = this.script.next(ctx.profile.id);
    if (typeof step === 'object' && 'kind' in step) throw new LaneQuotaSignal(step);
    this.report(ctx, step);
    return {
      id: 'r',
      model: 'm',
      message: { role: 'assistant', content: [{ type: 'text', text: `from ${ctx.profile.id}` }] },
      finishReason: 'stop',
    };
  }

  async *stream(req: UnifiedRequest, ctx: AttemptContext): AsyncIterable<StreamEvent> {
    this.script.calls.push(ctx.profile.id);
    this.script.requests.push({ profileId: ctx.profile.id, req });
    const step = this.script.next(ctx.profile.id);
    if (typeof step === 'object' && 'kind' in step) throw new LaneQuotaSignal(step);
    this.report(ctx, step);
    yield {
      type: 'start',
      id: `r-${ctx.profile.id}`,
      model: 'm',
      provider: ctx.profile.provider,
      profileId: ctx.profile.id,
    };
    if (typeof step === 'object' && 'toolOpen' in step) {
      yield { type: 'text', delta: 'Let me look. ' };
      yield { type: 'tool_call_start', id: 't1', name: 'search' };
      yield { type: 'tool_call_delta', id: 't1', argumentsDelta: '{"q":' };
      throw new LaneQuotaSignal(limit);
    }
    const texts =
      typeof step === 'object' && 'texts' in step ? step.texts : [`from ${ctx.profile.id}`];
    for (const delta of texts) yield { type: 'text', delta };
    if (typeof step === 'object' && 'cut' in step && step.cut) throw new LaneQuotaSignal(limit);
    yield { type: 'usage', usage: { outputTokens: 3 } };
    yield { type: 'finish', finishReason: 'stop' };
  }

  async checkAuth() {
    return 'ok' as const;
  }
}

const mk = (
  id: string,
  order: number,
  provider: Profile['provider'] = 'anthropic',
  lane: LaneKind = 'api-key',
): Profile => ({
  id,
  title: `Title ${id}`,
  provider,
  lane,
  order,
  enabled: true,
  ...(lane === 'cli' ? { cli: { home: `/nowhere/${id}` } } : { apiKey: { secretRef: `k:${id}` } }),
  createdAt: 'x',
  updatedAt: 'x',
});

function setup(
  steps: Record<string, Step[]>,
  profiles: Profile[],
  policy: Partial<FailoverPolicy> = {},
  nowMs = Date.UTC(2026, 8, 24, 12, 0, 0),
) {
  const script = new Script(steps);
  const apiKey = new ScriptedLane('api-key', script);
  const cli = new ScriptedLane('cli', script);
  const registry = new AdapterRegistry()
    .register({
      id: 'anthropic',
      displayName: 'A',
      defaultModel: 'm',
      lanes: { 'api-key': apiKey, cli },
    })
    .register({
      id: 'openai',
      displayName: 'O',
      defaultModel: 'm',
      lanes: { 'api-key': apiKey, cli },
    });
  const emitter = new TypedEmitter<IronEvent>();
  const events: IronEvent[] = [];
  emitter.onAny((e) => events.push(e));
  const clock = { t: nowMs, now: () => clock.t };
  const states = new MemoryStateStore();
  const router = new Router({
    profiles: new MemoryProfileStore(profiles),
    states,
    vault: new MemoryVault(),
    registry,
    emitter,
    clock,
    policy: { overloadRetries: 0, ...policy },
  });
  return { script, router, events, clock, states };
}

const req = (model = 'claude-x'): UnifiedRequest => ({
  model,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Write a sentence.' }] }],
});

const collect = async (it: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};
const textOf = (evs: StreamEvent[]) => evs.map((e) => (e.type === 'text' ? e.delta : '')).join('');
const switchedEvents = (events: IronEvent[]) =>
  events.filter(
    (e): e is Extract<IronEvent, { type: 'profile.switched' }> => e.type === 'profile.switched',
  );

/* ------------------------------------------------------------------ */
/* (A) Switch before the wall                                           */
/* ------------------------------------------------------------------ */

describe('pre-emptive switching', () => {
  it('skips a hot primary for the next request, parks nothing, and says why with source usage', async () => {
    const { router, script, events, states, clock } = setup(
      { a: [{ usage: 0.96, resetInMs: 3_600_000 }, 'ok'] },
      [mk('a', 0), mk('b', 1)],
    );
    expect((await router.complete(req())).profileId).toBe('a');
    expect((await states.get('a'))?.usage?.utilisation).toBe(0.96);

    expect((await router.complete(req())).profileId).toBe('b');
    expect(script.calls).toEqual(['a', 'b']); // a was not even tried
    const st = await states.get('a');
    expect(st?.status).not.toBe('parked');
    expect(st?.parkedUntil).toBeUndefined();
    expect(events.some((e) => e.type === 'profile.parked')).toBe(false);

    const sw = switchedEvents(events);
    expect(sw).toHaveLength(2); // first serve (no from), then the early switch
    expect(sw[1]).toMatchObject({
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: { kind: 'rate-limit', source: 'usage' },
    });
    const reason = sw[1]!.reason!;
    expect(reason.message).toMatch(/^Switched early: 96% of the window used, resets \S.*$/);
    expect(reason.message).not.toContain('Title'); // no account names, no secrets
    expect(reason.resetAt).toBe(new Date(clock.t + 3_600_000).toISOString());

    // Still hot: b keeps serving and, as the active profile did not change, no new switch event.
    expect((await router.complete(req())).profileId).toBe('b');
    expect(switchedEvents(events)).toHaveLength(2);

    // Once the window resets, the usage is stale and the primary is back first.
    clock.t += 3_600_001;
    expect((await router.complete(req())).profileId).toBe('a');
    expect(switchedEvents(events).at(-1)).toMatchObject({ fromProfileId: 'b', toProfileId: 'a' });
    expect(switchedEvents(events).at(-1)?.reason).toBeUndefined();
  });

  it('pre-empts streams too', async () => {
    const { router, script } = setup({ a: [{ usage: 0.99, resetInMs: 60_000 }, 'ok'] }, [
      mk('a', 0),
      mk('b', 1),
    ]);
    await collect(router.stream(req()));
    const evs = await collect(router.stream(req()));
    expect(evs[0]).toMatchObject({ type: 'start', profileId: 'b' });
    expect(script.calls).toEqual(['a', 'b']);
  });

  it('uses the normal order when every candidate is hot', async () => {
    const { router, script, events } = setup(
      {
        a: [{ usage: 0.97, resetInMs: 3_600_000 }, 'ok'],
        b: [{ usage: 0.98, resetInMs: 3_600_000 }, 'ok'],
      },
      [mk('a', 0), mk('b', 1)],
    );
    expect((await router.complete(req())).profileId).toBe('a'); // a becomes hot
    expect((await router.complete(req())).profileId).toBe('b'); // b becomes hot
    expect((await router.complete(req())).profileId).toBe('a'); // all hot: order stands
    expect(script.calls).toEqual(['a', 'b', 'a']);
    expect(switchedEvents(events).at(-1)?.reason).toBeUndefined();
  });

  it('ignores stale usage: a reset in the past, or no reset time', async () => {
    const past = setup({ a: [{ usage: 0.99, resetInMs: 60_000 }, 'ok'] }, [mk('a', 0), mk('b', 1)]);
    await past.router.complete(req());
    past.clock.t += 60_001; // the window it described has reset
    expect((await past.router.complete(req())).profileId).toBe('a');

    const noReset = setup({ a: [{ usage: 0.99 }, 'ok'] }, [mk('a', 0), mk('b', 1)]);
    await noReset.router.complete(req());
    expect((await noReset.router.complete(req())).profileId).toBe('a');
    noReset.clock.t += 11 * 60_000;
    expect((await noReset.router.complete(req())).profileId).toBe('a');

    const now = 1_000_000;
    expect(
      isUsageHot({ utilisation: 0.99, observedAt: new Date(now).toISOString() }, 0.95, now),
    ).toBe(false);
    expect(
      isUsageHot(
        {
          utilisation: 0.99,
          observedAt: new Date(now - 11 * 60_000).toISOString(),
          resetAt: new Date(now - 1).toISOString(),
        },
        0.95,
        now,
      ),
    ).toBe(false);
    expect(
      isUsageHot(
        {
          utilisation: 0.95,
          observedAt: new Date(now).toISOString(),
          resetAt: new Date(now + 1).toISOString(),
        },
        0.95,
        now,
      ),
    ).toBe(true);
  });

  it('a threshold of 1 turns pre-emption off', async () => {
    const { router, script } = setup(
      { a: [{ usage: 1, resetInMs: 3_600_000 }, 'ok'] },
      [mk('a', 0), mk('b', 1)],
      { preemptAtUtilisation: 1 },
    );
    await router.complete(req());
    expect((await router.complete(req())).profileId).toBe('a');
    expect(script.calls).toEqual(['a', 'a']);
  });

  it('honours a per-provider override', async () => {
    const { router, script } = setup(
      {
        a: [{ usage: 0.6, resetInMs: 3_600_000 }, 'ok'],
        o1: [{ usage: 0.6, resetInMs: 3_600_000 }, 'ok'],
      },
      [mk('a', 0), mk('b', 1), mk('o1', 0, 'openai'), mk('o2', 1, 'openai')],
      { providers: { openai: { preemptAtUtilisation: 0.5 } } },
    );
    await router.complete(req());
    await router.complete(req('gpt-x'));
    expect((await router.complete(req())).profileId).toBe('a'); // 60% is below the 95% default
    expect((await router.complete(req('gpt-x'))).profileId).toBe('o2'); // openai switches at 50%
    expect(script.calls).toEqual(['a', 'o1', 'a', 'o2']);
  });

  it('never pre-empts a pinned profile', async () => {
    const { router } = setup({ a: [{ usage: 0.99, resetInMs: 3_600_000 }, 'ok'] }, [
      mk('a', 0),
      mk('b', 1),
    ]);
    await router.complete(req());
    expect((await router.complete(req(), { profileId: 'a' })).profileId).toBe('a');
  });
});

/* ------------------------------------------------------------------ */
/* (B) Continue a cut-off answer                                        */
/* ------------------------------------------------------------------ */

describe('resume after a mid-stream limit', () => {
  it('continues on the next account as one text, with the partial text and the continue instruction', async () => {
    const { router, script, states, events } = setup(
      { a: [{ texts: ['Hello ', 'wor'], cut: true }], b: [{ texts: ['ld!'] }] },
      [mk('a', 0, 'openai'), mk('b', 1, 'openai')],
    );
    const evs = await collect(router.stream(req('gpt-x'), { resumeInterrupted: true }));
    expect(evs.map((e) => e.type)).toEqual([
      'start',
      'text',
      'text',
      'switched',
      'text',
      'usage',
      'finish',
    ]);
    expect(evs[0]).toMatchObject({ type: 'start', profileId: 'a' });
    expect(evs[3]).toMatchObject({
      type: 'switched',
      fromProfileId: 'a',
      toProfileId: 'b',
      resumed: true,
      reason: { kind: 'rate-limit' },
    });
    expect(textOf(evs)).toBe('Hello world!');
    expect((await states.get('a'))?.status).toBe('parked');
    expect(events.some((e) => e.type === 'request.failed')).toBe(false);

    const cont = script.requests.find((r) => r.profileId === 'b')!.req;
    expect(cont.model).toBe('gpt-x');
    expect(cont.messages).toEqual([
      ...req().messages,
      { role: 'assistant', content: [{ type: 'text', text: 'Hello wor' }] },
      { role: 'user', content: [{ type: 'text', text: CONTINUE_INSTRUCTION }] },
    ]);
    expect(CONTINUE_INSTRUCTION).toBe(
      'Continue exactly where you stopped. Do not repeat any text you already wrote.',
    );
  });

  it('gives the Anthropic API lane an assistant prefill, trimmed, with no extra user turn', async () => {
    const { router, script } = setup(
      { a: [{ texts: ['The answer ', 'is  \n'], cut: true }], b: [{ texts: [' 42.'] }] },
      [mk('a', 0), mk('b', 1)],
    );
    const evs = await collect(router.stream(req(), { resumeInterrupted: true }));
    expect(textOf(evs)).toBe('The answer is  \n 42.');
    const cont = script.requests.find((r) => r.profileId === 'b')!.req;
    expect(cont.messages).toEqual([
      ...req().messages,
      { role: 'assistant', content: [{ type: 'text', text: 'The answer is' }] },
    ]);
  });

  it('gives the Anthropic CLI lane the continue instruction like every other lane', async () => {
    const { router, script } = setup(
      { a: [{ texts: ['Part one '], cut: true }], b: [{ texts: ['part two.'] }] },
      [mk('a', 0, 'anthropic', 'cli'), mk('b', 1, 'anthropic', 'cli')],
    );
    const evs = await collect(router.stream(req(), { resumeInterrupted: true }));
    expect(textOf(evs)).toBe('Part one part two.');
    const cont = script.requests.find((r) => r.profileId === 'b')!.req;
    expect(cont.messages.slice(-2)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Part one ' }] },
      { role: 'user', content: [{ type: 'text', text: CONTINUE_INSTRUCTION }] },
    ]);
  });

  it('chains across three accounts, each continuation carrying all the text so far', async () => {
    const { router, script, states } = setup(
      {
        a: [{ texts: ['one '], cut: true }],
        b: [{ texts: ['two '], cut: true }],
        c: [{ texts: ['three.'] }],
      },
      [mk('a', 0, 'openai'), mk('b', 1, 'openai'), mk('c', 2, 'openai')],
    );
    const evs = await collect(router.stream(req('gpt-x'), { resumeInterrupted: true }));
    expect(evs.filter((e) => e.type === 'start')).toHaveLength(1);
    expect(evs.filter((e) => e.type === 'switched')).toEqual([
      expect.objectContaining({ fromProfileId: 'a', toProfileId: 'b', resumed: true }),
      expect.objectContaining({ fromProfileId: 'b', toProfileId: 'c', resumed: true }),
    ]);
    expect(textOf(evs)).toBe('one two three.');
    expect(evs.at(-1)).toMatchObject({ type: 'finish' });
    const partials = script.requests
      .filter((r) => r.profileId !== 'a')
      .map((r) => r.req.messages.at(-2)?.content[0]);
    expect(partials).toEqual([
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'one two ' },
    ]);
    expect((await states.get('a'))?.status).toBe('parked');
    expect((await states.get('b'))?.status).toBe('parked');
  });

  it('skips a continuation account that is limited before it starts', async () => {
    const { router } = setup(
      { a: [{ texts: ['one '], cut: true }], b: [limit], c: [{ texts: ['two.'] }] },
      [mk('a', 0, 'openai'), mk('b', 1, 'openai'), mk('c', 2, 'openai')],
    );
    const evs = await collect(router.stream(req('gpt-x'), { resumeInterrupted: true }));
    expect(evs.map((e) => e.type)).toEqual([
      'start',
      'text',
      'switched',
      'text',
      'usage',
      'finish',
    ]);
    expect(evs[2]).toMatchObject({ fromProfileId: 'a', toProfileId: 'c', resumed: true });
    expect(textOf(evs)).toBe('one two.');
  });

  it('ends with STREAM_INTERRUPTED when nobody is left to continue', async () => {
    const { router, events } = setup(
      { a: [{ texts: ['one '], cut: true }], b: [{ texts: ['two '], cut: true }] },
      [mk('a', 0, 'openai'), mk('b', 1, 'openai')],
    );
    const evs = await collect(router.stream(req('gpt-x'), { resumeInterrupted: true }));
    expect(evs.map((e) => e.type)).toEqual(['start', 'text', 'switched', 'text', 'error']);
    expect(evs.at(-1)).toMatchObject({
      error: { code: 'STREAM_INTERRUPTED', retryable: true, details: { profileId: 'b' } },
    });
    expect(events.filter((e) => e.type === 'request.failed')).toHaveLength(1);
  });

  it('does not resume while a tool call is open', async () => {
    const { router, script } = setup({ a: [{ toolOpen: true }] }, [
      mk('a', 0, 'openai'),
      mk('b', 1, 'openai'),
    ]);
    const evs = await collect(router.stream(req('gpt-x'), { resumeInterrupted: true }));
    expect(evs.map((e) => e.type)).toEqual([
      'start',
      'text',
      'tool_call_start',
      'tool_call_delta',
      'error',
    ]);
    expect(evs.at(-1)).toMatchObject({ error: { code: 'STREAM_INTERRUPTED' } });
    expect(script.calls).toEqual(['a']);
  });

  it("keeps today's behaviour when resume is off, and the policy default can turn it on", async () => {
    const off = setup({ a: [{ texts: ['one '], cut: true }] }, [
      mk('a', 0, 'openai'),
      mk('b', 1, 'openai'),
    ]);
    const evs = await collect(off.router.stream(req('gpt-x')));
    expect(evs.map((e) => e.type)).toEqual(['start', 'text', 'error']);
    expect(evs.at(-1)).toMatchObject({ error: { code: 'STREAM_INTERRUPTED', retryable: true } });
    expect(off.script.calls).toEqual(['a']);

    const policyOn = setup(
      { a: [{ texts: ['one '], cut: true }], b: [{ texts: ['two'] }] },
      [mk('a', 0, 'openai'), mk('b', 1, 'openai')],
      { resumeInterrupted: true },
    );
    expect(textOf(await collect(policyOn.router.stream(req('gpt-x'))))).toBe('one two');

    const optedOut = setup(
      { a: [{ texts: ['one '], cut: true }] },
      [mk('a', 0, 'openai'), mk('b', 1, 'openai')],
      { resumeInterrupted: true },
    );
    const outEvs = await collect(
      optedOut.router.stream(req('gpt-x'), { resumeInterrupted: false }),
    );
    expect(outEvs.at(-1)).toMatchObject({ error: { code: 'STREAM_INTERRUPTED' } });
  });

  it('never crosses providers to continue', async () => {
    const { router, script } = setup({ a: [{ texts: ['one '], cut: true }] }, [
      mk('a', 0, 'openai'),
      mk('c', 0, 'anthropic'),
    ]);
    const evs = await collect(router.stream(req('gpt-x'), { resumeInterrupted: true }));
    expect(evs.at(-1)).toMatchObject({ error: { code: 'STREAM_INTERRUPTED' } });
    expect(script.calls).toEqual(['a']);
  });

  it('continuationRequest appends to a caller prefill on the Anthropic API lane', () => {
    const base: UnifiedRequest = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Sure:' }] },
      ],
    };
    const out = continuationRequest(base, ' one two ', { provider: 'anthropic', lane: 'api-key' });
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]?.content).toEqual([
      { type: 'text', text: 'Sure:' },
      { type: 'text', text: ' one two' },
    ]);
    expect(base.messages[1]?.content).toHaveLength(1); // the original is not mutated
  });

  it('merges the partial text into a caller prefill on a non-Anthropic lane, then asks it to continue', async () => {
    const prefilled: UnifiedRequest = {
      model: 'gpt-x',
      messages: [
        ...req('gpt-x').messages,
        { role: 'assistant', content: [{ type: 'text', text: 'Sure:' }] },
      ],
    };
    const { router, script } = setup(
      { a: [{ texts: [' one ', 'two '], cut: true }], b: [{ texts: ['three.'] }] },
      [mk('a', 0, 'openai'), mk('b', 1, 'openai')],
    );
    const evs = await collect(router.stream(prefilled, { resumeInterrupted: true }));
    expect(textOf(evs)).toBe(' one two three.');
    const cont = script.requests.find((r) => r.profileId === 'b')!.req;
    // One assistant turn (the caller's prefill plus the partial), never two in a row.
    expect(cont.messages).toEqual([
      ...req('gpt-x').messages,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure:' },
          { type: 'text', text: ' one two ' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: CONTINUE_INSTRUCTION }] },
    ]);
    for (let i = 1; i < cont.messages.length; i++)
      expect(
        cont.messages[i]!.role === 'assistant' && cont.messages[i - 1]!.role === 'assistant',
      ).toBe(false);
    expect(prefilled.messages).toHaveLength(2); // the caller's request is not mutated

    // The Anthropic CLI lane (not the API) is merged the same way.
    const cli = continuationRequest(prefilled, 'x ', { provider: 'anthropic', lane: 'cli' });
    expect(cli.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(cli.messages[1]?.content).toEqual([
      { type: 'text', text: 'Sure:' },
      { type: 'text', text: 'x ' },
    ]);
  });
});
