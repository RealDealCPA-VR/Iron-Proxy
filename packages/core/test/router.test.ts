import { describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  LaneQuotaSignal,
  type AttemptContext,
  type Lane,
  type LaneResponse,
} from '../src/adapters/types.js';
import {
  AllProfilesExhaustedError,
  AuthRequiredError,
  NoProfileError,
  ProviderError,
  QuotaExceededError,
} from '../src/errors.js';
import { TypedEmitter } from '../src/events.js';
import { Router } from '../src/router/router.js';
import { MemoryProfileStore } from '../src/store/profile-store.js';
import { MemoryStateStore } from '../src/store/state-store.js';
import type { IronEvent, Profile, QuotaSignal, StreamEvent, UnifiedRequest } from '../src/types.js';
import { MemoryVault } from '../src/vault/vault.js';

type Behaviour = 'ok' | QuotaSignal | Error | 'mid-stream-quota';

/** A scripted lane: behaviour per profile id, consumed in order (last repeats). */
class ScriptedLane implements Lane {
  readonly kind = 'api-key' as const;
  readonly calls: string[] = [];
  constructor(private readonly script: Record<string, Behaviour[]>) {}
  private next(id: string): Behaviour {
    const list = this.script[id] ?? ['ok'];
    return list.length > 1 ? list.shift()! : list[0]!;
  }
  async complete(_req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse> {
    this.calls.push(ctx.profile.id);
    const b = this.next(ctx.profile.id);
    if (b === 'ok' || b === 'mid-stream-quota')
      return {
        id: 'r',
        model: 'm',
        message: { role: 'assistant', content: [{ type: 'text', text: `from ${ctx.profile.id}` }] },
        finishReason: 'stop',
      };
    if (b instanceof Error) throw b;
    throw new LaneQuotaSignal(b);
  }
  async *stream(_req: UnifiedRequest, ctx: AttemptContext): AsyncIterable<StreamEvent> {
    this.calls.push(ctx.profile.id);
    const b = this.next(ctx.profile.id);
    if (b instanceof Error) throw b;
    if (b !== 'ok' && b !== 'mid-stream-quota') throw new LaneQuotaSignal(b);
    yield {
      type: 'start',
      id: 'r',
      model: 'm',
      provider: ctx.profile.provider,
      profileId: ctx.profile.id,
    };
    yield { type: 'text', delta: `from ${ctx.profile.id}` };
    if (b === 'mid-stream-quota')
      throw new LaneQuotaSignal({ kind: 'rate-limit', source: 'status' });
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
  enabled = true,
): Profile => ({
  id,
  title: id,
  provider,
  lane: 'api-key',
  order,
  enabled,
  apiKey: { secretRef: `k:${id}` },
  createdAt: 'x',
  updatedAt: 'x',
});

function setup(script: Record<string, Behaviour[]>, profiles: Profile[], nowMs = 1_000_000) {
  const lane = new ScriptedLane(script);
  const registry = new AdapterRegistry().register({
    id: 'anthropic',
    displayName: 'A',
    defaultModel: 'm',
    lanes: { 'api-key': lane },
  });
  registry.register({
    id: 'openai',
    displayName: 'O',
    defaultModel: 'm',
    lanes: { 'api-key': lane },
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
    policy: { overloadRetries: 0 },
  });
  return { lane, router, events, clock, states };
}

const req: UnifiedRequest = {
  model: 'claude-x',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};
const rateLimit = (resetInMs: number, now: number): QuotaSignal => ({
  kind: 'rate-limit',
  source: 'header',
  resetAt: new Date(now + resetInMs).toISOString(),
});

describe('Router failover', () => {
  it('uses the lowest-order ready profile', async () => {
    const { router, lane } = setup({}, [mk('b', 1), mk('a', 0)]);
    const res = await router.complete(req);
    expect(res.profileId).toBe('a');
    expect(lane.calls).toEqual(['a']);
  });

  it('parks on a quota signal and moves to the next account, emitting events', async () => {
    const now = 1_000_000;
    const { router, lane, events, states } = setup(
      { a: [rateLimit(60_000, now)] },
      [mk('a', 0), mk('b', 1)],
      now,
    );
    const res = await router.complete(req);
    expect(res.profileId).toBe('b');
    expect(lane.calls).toEqual(['a', 'b']);
    expect((await states.get('a'))?.status).toBe('parked');
    expect((await states.get('a'))?.parkedUntil).toBe(new Date(now + 60_000).toISOString());
    expect(events.map((e) => e.type)).toContain('profile.parked');
    expect(events.find((e) => e.type === 'profile.switched')).toMatchObject({ toProfileId: 'b' });
  });

  it('auto-returns to the primary once its park expires', async () => {
    const now = 1_000_000;
    const { router, lane, clock } = setup(
      { a: [rateLimit(60_000, now), 'ok'] },
      [mk('a', 0), mk('b', 1)],
      now,
    );
    expect((await router.complete(req)).profileId).toBe('b');
    expect((await router.complete(req)).profileId).toBe('b'); // still parked
    clock.t = now + 61_000;
    expect((await router.complete(req)).profileId).toBe('a');
    expect(lane.calls).toEqual(['a', 'b', 'b', 'a']);
  });

  it('throws AllProfilesExhaustedError with the earliest reset when every account is parked', async () => {
    const now = 1_000_000;
    const { router, events } = setup(
      { a: [rateLimit(120_000, now)], b: [rateLimit(30_000, now)] },
      [mk('a', 0), mk('b', 1)],
      now,
    );
    const err = await router.complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(AllProfilesExhaustedError);
    expect(err.earliestResetAt).toBe(new Date(now + 30_000).toISOString());
    expect(events.find((e) => e.type === 'provider.exhausted')).toBeDefined();
  });

  it('never crosses providers', async () => {
    const now = 1_000_000;
    const { router, lane } = setup(
      { a: [rateLimit(60_000, now)] },
      [mk('a', 0, 'anthropic'), mk('o', 0, 'openai')],
      now,
    );
    await expect(router.complete(req)).rejects.toBeInstanceOf(AllProfilesExhaustedError);
    expect(lane.calls).toEqual(['a']);
  });

  it('skips disabled profiles and reports NoProfileError when none exist', async () => {
    const { router } = setup({}, [mk('a', 0, 'anthropic', false)]);
    await expect(router.complete(req)).rejects.toBeInstanceOf(NoProfileError);
  });

  it('propagates non-quota provider errors without failing over', async () => {
    const { router, lane } = setup({ a: [new ProviderError('bad request', { status: 400 })] }, [
      mk('a', 0),
      mk('b', 1),
    ]);
    await expect(router.complete(req)).rejects.toThrow('bad request');
    expect(lane.calls).toEqual(['a']);
  });

  it('treats 5xx as overload and fails over after retries are exhausted', async () => {
    const { router, lane, states } = setup({ a: [new ProviderError('down', { status: 503 })] }, [
      mk('a', 0),
      mk('b', 1),
    ]);
    expect((await router.complete(req)).profileId).toBe('b');
    expect(lane.calls).toEqual(['a', 'b']);
    expect((await states.get('a'))?.parkedReason?.kind).toBe('overloaded');
  });

  it('marks auth-expired accounts unauthenticated and moves on; alone it surfaces AuthRequiredError', async () => {
    const authSig: QuotaSignal = { kind: 'auth-expired', source: 'status', message: 'login again' };
    const { router, states } = setup({ a: [authSig] }, [mk('a', 0), mk('b', 1)]);
    expect((await router.complete(req)).profileId).toBe('b');
    expect((await states.get('a'))?.status).toBe('unauthenticated');
    const solo = setup({ a: [authSig] }, [mk('a', 0)]);
    await expect(solo.router.complete(req)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('pinned + strict never switches and surfaces QuotaExceededError', async () => {
    const now = 1_000_000;
    const { router, lane } = setup({ b: [rateLimit(60_000, now)] }, [mk('a', 0), mk('b', 1)], now);
    await expect(router.complete(req, { profileId: 'b', strict: true })).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(lane.calls).toEqual(['b']);
    // pinned without strict: starts at b, then falls back to a
    expect((await router.complete(req, { profileId: 'b' })).profileId).toBe('a');
  });

  it('unpark clears a park early', async () => {
    const now = 1_000_000;
    const { router, lane } = setup(
      { a: [rateLimit(600_000, now), 'ok'] },
      [mk('a', 0), mk('b', 1)],
      now,
    );
    expect((await router.complete(req)).profileId).toBe('b');
    await router.unpark('a');
    expect((await router.complete(req)).profileId).toBe('a');
    expect(lane.calls).toEqual(['a', 'b', 'a']);
  });

  it('infers the provider or fails clearly', async () => {
    const { router } = setup({}, [mk('a', 0, 'anthropic'), mk('o', 0, 'openai')]);
    expect((await router.complete({ ...req, model: 'gpt-5' })).profileId).toBe('o');
    await expect(router.complete({ ...req, model: 'mystery' })).rejects.toThrow(
      /Cannot infer the provider/,
    );
    const single = setup({}, [mk('a', 0)]);
    expect((await single.router.complete({ ...req, model: 'mystery' })).profileId).toBe('a');
  });
});

describe('Router streaming', () => {
  const collect = async (it: AsyncIterable<StreamEvent>) => {
    const out: StreamEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  it('fails over silently before any content and reports the switch', async () => {
    const now = 1_000_000;
    const { router } = setup({ a: [rateLimit(60_000, now)] }, [mk('a', 0), mk('b', 1)], now);
    const evs = await collect(router.stream(req));
    expect(evs.map((e) => e.type)).toEqual(['switched', 'start', 'text', 'finish']);
    expect(evs[0]).toMatchObject({ fromProfileId: 'a', toProfileId: 'b' });
  });

  it('surfaces STREAM_INTERRUPTED when the limit hits mid-stream, and parks the account', async () => {
    const { router, states } = setup({ a: ['mid-stream-quota'] }, [mk('a', 0), mk('b', 1)]);
    const evs = await collect(router.stream(req));
    expect(evs.map((e) => e.type)).toEqual(['start', 'text', 'error']);
    expect(evs[2]).toMatchObject({ error: { code: 'STREAM_INTERRUPTED', retryable: true } });
    expect((await states.get('a'))?.status).toBe('parked');
    // the resend lands on b
    const again = await collect(router.stream(req));
    expect(again[0]).toMatchObject({ type: 'start', profileId: 'b' });
  });

  it('emits an error event when everything is exhausted', async () => {
    const now = 1_000_000;
    const { router } = setup({ a: [rateLimit(60_000, now)] }, [mk('a', 0)], now);
    const evs = await collect(router.stream(req));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'error', error: { code: 'ALL_PROFILES_EXHAUSTED' } });
  });
});
