import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSpec,
  CliLane,
  codexSpec,
  createDefaultRegistry,
  createIronProxy,
  MemoryProfileStore,
  MemoryStateStore,
  MemoryUsageStore,
  MemoryVault,
  type IronEvent,
  type IronProxy,
  type Lane,
  type Profile,
  type ProfileState,
  type ProviderId,
} from '../src/index.js';

/**
 * Plan and usage windows per account, learned from what an external executor
 * reports (Claude's anthropic-ratelimit-unified-* headers, Codex's rate-limit
 * snapshot) and from the vendor CLI's own status output (Claude Code's
 * `auth status`). Driven through the real manager and router with memory stores,
 * a fixed clock and the fake vendor CLI (never a real one).
 */

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli/fake-cli.mjs', import.meta.url));

let dir: string;
let iron: IronProxy;
let now: number;
let events: IronEvent[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-plan-'));
  now = Date.parse('2026-10-21T12:00:00Z');
  const clock = { now: () => now };
  iron = createIronProxy({
    dataDir: dir,
    profiles: new MemoryProfileStore(),
    states: new MemoryStateStore(),
    usage: new MemoryUsageStore({ clock }),
    vault: new MemoryVault(),
    clock,
    // Every vendor CLI here is the fake, so nothing can ever run the real one.
    registry: createDefaultRegistry()
      .addLane('anthropic', new CliLane({ ...claudeSpec, binary: FAKE }))
      .addLane('openai', new CliLane({ ...codexSpec, binary: FAKE })),
  });
  events = [];
  iron.events.onAny((e) => events.push(e));
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();
const secs = (ms: number) => Math.floor(ms / 1000);

async function put(
  id: string,
  opts: {
    provider?: ProviderId;
    plan?: string;
    loggedIn?: boolean;
    state?: Partial<ProfileState>;
  } = {},
): Promise<Profile> {
  const provider = opts.provider ?? 'anthropic';
  const home = join(dir, id);
  await mkdir(home, { recursive: true });
  if (opts.loggedIn ?? true) await writeFile(join(home, 'logged-in'), 'yes');
  const p: Profile = {
    id,
    title: `T ${id}`,
    provider,
    lane: 'cli',
    order: 0,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    cli: {
      home,
      env: {
        FAKE_CLI_FLAVOR: provider === 'openai' ? 'codex' : 'claude',
        ...(opts.plan ? { FAKE_CLI_PLAN: opts.plan } : {}),
      },
    },
  };
  await iron.profiles.put(p);
  await iron.states.put({ profileId: id, status: 'ready', served: 0, ...(opts.state ?? {}) });
  return p;
}

/** How many times the fake vendor CLI ran in this account's home. */
async function runs(id: string): Promise<number> {
  const log = await readFile(join(dir, id, 'invocations.log'), 'utf8').catch(() => '');
  return log.split('\n').filter(Boolean).length;
}

const claudeHeaders = (u5h: string, u7d: string, r5h: number, r7d: number) => ({
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': u5h,
  'anthropic-ratelimit-unified-5h-reset': String(secs(r5h)),
  'anthropic-ratelimit-unified-7d-utilization': u7d,
  'anthropic-ratelimit-unified-7d-reset': String(secs(r7d)),
  'retry-after': '1',
});

describe('reportFinished learns usage windows and the plan', () => {
  it('Claude: the 5h and 7d windows from the forwarded headers, on the served state and its event', async () => {
    await put('a');
    const r5h = now + 2 * 3_600_000;
    const r7d = now + 3 * 86_400_000;
    const state = await iron.reportFinished('a', {
      durationMs: 100,
      headers: claudeHeaders('0.12', '0.38', r5h, r7d),
    });
    const expected = [
      {
        kind: '5h',
        usedPercent: 12,
        windowMins: 300,
        resetsAt: iso(secs(r5h) * 1000),
        source: 'headers',
        at: iso(now),
      },
      {
        kind: '7d',
        usedPercent: 38,
        windowMins: 10_080,
        resetsAt: iso(secs(r7d) * 1000),
        source: 'headers',
        at: iso(now),
      },
    ];
    expect(state).toMatchObject({ status: 'active', served: 1, windows: expected });
    expect((await iron.allStates()).a?.windows).toEqual(expected);
    const last = events.filter((e) => e.type === 'profile.state').pop();
    expect(last).toMatchObject({ state: { profileId: 'a', windows: expected } });
    expect(state.plan).toBeUndefined(); // the headers carry no plan
  });

  it('Codex: planType and the primary / secondary windows from the snapshot', async () => {
    await put('o', { provider: 'openai' });
    const observed = secs(now) - 5;
    const state = await iron.reportFinished('o', {
      usage: { inputTokens: 1, outputTokens: 1 },
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: secs(now + 3_600_000) },
        secondary: {
          usedPercent: 38,
          windowDurationMins: 10_080,
          resetsAt: secs(now + 86_400_000),
        },
        observedAt: observed,
      },
    });
    expect(state).toMatchObject({
      status: 'active',
      plan: 'plus',
      planSource: 'rate-limits',
      planAt: iso(observed * 1000),
      windows: [
        { kind: 'primary', usedPercent: 4, windowMins: 300, source: 'rate-limits' },
        { kind: 'secondary', usedPercent: 38, windowMins: 10_080, source: 'rate-limits' },
      ],
    });
  });

  it('keeps the newest reading: a snapshot read earlier than the stored one changes nothing', async () => {
    await put('o', { provider: 'openai' });
    const newer = {
      planType: 'pro',
      secondary: { usedPercent: 60, resetsAt: secs(now + 86_400_000) },
      observedAt: secs(now),
    };
    await iron.reportFinished('o', { rateLimits: newer });
    const after = await iron.reportFinished('o', {
      rateLimits: {
        ...newer,
        planType: 'plus',
        secondary: { usedPercent: 10 },
        observedAt: secs(now) - 60,
      },
    });
    expect(after).toMatchObject({ plan: 'pro', windows: [{ kind: 'secondary', usedPercent: 60 }] });
    now += 1000;
    const later = await iron.reportFinished('o', {
      rateLimits: { planType: 'team', secondary: { usedPercent: 61 } },
    });
    expect(later).toMatchObject({
      plan: 'team',
      planAt: iso(now),
      windows: [{ kind: 'secondary', usedPercent: 61, at: iso(now) }],
    });
  });

  it('a report with none of the new fields leaves the state exactly as before', async () => {
    await put('a');
    const state = await iron.reportFinished('a', { durationMs: 5 });
    expect(Object.keys(state).sort()).toEqual(['lastUsedAt', 'profileId', 'served', 'status']);
  });

  it('rejects a rateLimits or headers that is not an object; tolerates unreadable fields inside', async () => {
    await put('o', { provider: 'openai' });
    for (const bad of [
      { rateLimits: [] },
      { rateLimits: 'plus' },
      { rateLimits: 3 },
      { headers: { 'anthropic-ratelimit-unified-5h-utilization': 0.5 } },
      { headers: 'x' },
    ]) {
      await expect(
        iron.reportFinished('o', bad as never),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    expect((await iron.allStates()).o?.served).toBe(0);
    const state = await iron.reportFinished('o', {
      rateLimits: { planType: 7, primary: { usedPercent: 'x' }, secondary: [], extra: 1 } as never,
    });
    expect(state.served).toBe(1);
    expect(state.plan).toBeUndefined();
    expect(state.windows).toBeUndefined();
    // `null` is "no snapshot" (a host that had none), never a reason to lose the report.
    expect((await iron.reportFinished('o', { rateLimits: null } as never)).served).toBe(2);
  });
});

describe('reportSignal learns usage windows too', () => {
  it('a report that parks nothing still stores its windows and emits the state', async () => {
    await put('o', { provider: 'openai' });
    const r = await iron.reportSignal('o', {
      text: 'Error: file not found',
      rateLimits: { planType: 'plus', primary: { usedPercent: 50 } },
    });
    expect(r).toEqual({ parked: false });
    const st = (await iron.allStates()).o;
    expect(st).toMatchObject({
      status: 'ready',
      plan: 'plus',
      windows: [{ kind: 'primary', usedPercent: 50 }],
    });
    expect(events).toContainEqual({ type: 'profile.state', state: st });
  });

  it('a limit with no reset in its text parks until the reset of the window the snapshot says is used up', async () => {
    await put('o', { provider: 'openai' });
    const weekly = secs(now + 4 * 86_400_000);
    const r = await iron.reportSignal('o', {
      text: "You've hit your usage limit.",
      rateLimits: {
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: secs(now + 3_600_000) },
        secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: weekly },
      },
    });
    if (!r.parked) throw new Error('expected a park');
    expect(r.signal).toMatchObject({ kind: 'quota-exhausted', resetAt: iso(weekly * 1000) });
    expect(r.state).toMatchObject({
      status: 'parked',
      parkedUntil: iso(weekly * 1000),
      windows: [{ kind: 'primary' }, { kind: 'secondary', usedPercent: 100 }],
    });
  });

  it('a reset the classifier found is kept; windows below 100% never set one', async () => {
    await put('o', { provider: 'openai' });
    const r = await iron.reportSignal('o', {
      text: "You've hit your usage limit.",
      rateLimits: { secondary: { usedPercent: 90, resetsAt: secs(now + 86_400_000) } },
    });
    if (!r.parked) throw new Error('expected a park');
    expect(r.signal.resetAt).toBeUndefined();
    expect(Date.parse(r.state.parkedUntil!)).toBe(now + 30 * 60_000); // the quota default
    await put('p', { provider: 'openai' });
    const withReset = await iron.reportSignal('p', {
      status: 429,
      headers: { 'retry-after': '120' },
      text: 'rate limited',
      rateLimits: { secondary: { usedPercent: 100, resetsAt: secs(now + 86_400_000) } },
    });
    if (!withReset.parked) throw new Error('expected a park');
    expect(withReset.signal.retryAfterMs).toBe(120_000);
    expect(withReset.state.parkedUntil).toBe(iso(now + 120_000));
  });

  it('Claude: a 429 parks until the unified reset (unix seconds) and stores the windows', async () => {
    await put('a');
    const reset = now + 5 * 3_600_000;
    const r = await iron.reportSignal('a', {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(secs(reset)),
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': String(secs(reset)),
      },
      text: '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
    });
    if (!r.parked) throw new Error('expected a park');
    expect(r.state).toMatchObject({
      status: 'parked',
      parkedUntil: iso(secs(reset) * 1000),
      windows: [{ kind: '5h', usedPercent: 100, resetsAt: iso(secs(reset) * 1000) }],
    });
  });

  it('Claude: a 429 the subscription limit did not cause parks for its retry-after, not until the window ends (review)', async () => {
    await put('a');
    const windowEnd = now + 4 * 3_600_000;
    const r = await iron.reportSignal('a', {
      status: 429,
      // What a host forwards from a subscription response: the status says allowed,
      // and unified-reset is only the end of the current window.
      headers: {
        ...claudeHeaders('0.4', '0.2', windowEnd, now + 86_400_000),
        'anthropic-ratelimit-unified-reset': String(secs(windowEnd)),
        'retry-after': '20',
      },
      text: '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
    });
    if (!r.parked) throw new Error('expected a park');
    expect(r.signal.resetAt).toBeUndefined();
    expect(r.state).toMatchObject({
      status: 'parked',
      parkedUntil: iso(now + 20_000),
      windows: [
        { kind: '5h', usedPercent: 40 },
        { kind: '7d', usedPercent: 20 },
      ],
    });
  });

  it('rejects a rateLimits that is not an object', async () => {
    await put('o', { provider: 'openai' });
    await expect(
      iron.reportSignal('o', { text: 'limit reached', rateLimits: 'x' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect((await iron.allStates()).o?.status).toBe('ready');
  });
});

describe('a window whose reset has passed', () => {
  it('is left out of allStates once the clock passes it', async () => {
    await put('a');
    await iron.reportFinished('a', {
      headers: claudeHeaders('0.5', '0.2', now + 60_000, now + 86_400_000),
    });
    expect((await iron.allStates()).a?.windows?.map((w) => w.kind)).toEqual(['5h', '7d']);
    now += 120_000;
    expect((await iron.allStates()).a?.windows?.map((w) => w.kind)).toEqual(['7d']);
    now += 86_400_000;
    expect((await iron.allStates()).a?.windows).toBeUndefined();
  });

  it('is left out of every state the router hands back, and dropped by its next write', async () => {
    await put('a');
    await iron.reportFinished('a', {
      headers: claudeHeaders('0.5', '0.2', now + 60_000, now + 86_400_000),
    });
    now += 120_000;
    events = [];
    const state = await iron.reportFinished('a', { durationMs: 1 }); // nothing new learned
    expect(state.windows?.map((w) => w.kind)).toEqual(['7d']);
    const last = events.filter((e) => e.type === 'profile.state').pop();
    expect(last?.type === 'profile.state' && last.state.windows?.map((w) => w.kind)).toEqual([
      '7d',
    ]);
    expect((await iron.states.get('a'))?.windows?.map((w) => w.kind)).toEqual(['7d']);
  });
});

describe('refreshStatus reads the Claude plan from `claude auth status`', () => {
  it('stores subscriptionType as the plan, and never the email or organisation beside it', async () => {
    await put('a', { plan: 'max', state: { status: 'unknown' } });
    const [st] = await iron.refreshStatus('a');
    expect(st).toMatchObject({
      status: 'ready',
      plan: 'max',
      planSource: 'cli-status',
      planAt: iso(now),
    });
    const everything = JSON.stringify([await iron.allStates(), events]);
    expect(everything).not.toContain('someone@example.test');
    expect(everything).not.toContain('Organization');
  });

  it('a signed-out account, or one with no subscription, gets no plan', async () => {
    await put('out', { plan: 'max', loggedIn: false, state: { status: 'unknown' } });
    await put('none', { state: { status: 'unknown' } });
    const states = await iron.refreshStatus();
    const byId = Object.fromEntries(states.map((s) => [s.profileId, s]));
    expect(byId.out).toMatchObject({ status: 'unauthenticated' });
    expect(byId.out?.plan).toBeUndefined();
    expect(byId.none).toMatchObject({ status: 'ready' });
    expect(byId.none?.plan).toBeUndefined();
  });

  it('a serving account is not re-judged: the status runs once for its plan, then not again', async () => {
    await put('a', { plan: 'pro', state: { status: 'active', served: 3 } });
    const [st] = await iron.refreshStatus('a');
    expect(st).toMatchObject({ status: 'active', served: 3, plan: 'pro' });
    expect(await runs('a')).toBe(1);
    await iron.refreshStatus('a');
    expect(await runs('a')).toBe(1);
  });

  it('a parked account stays parked (even when the CLI says signed out); only its plan is learned', async () => {
    const until = iso(now + 3_600_000);
    await put('a', {
      plan: 'max',
      loggedIn: false,
      state: {
        status: 'parked',
        parkedUntil: until,
        parkedReason: { kind: 'quota-exhausted', source: 'cli-output' },
      },
    });
    await put('b', { plan: 'max', state: { status: 'parked', parkedUntil: until } });
    const states = await iron.refreshStatus();
    const byId = Object.fromEntries(states.map((s) => [s.profileId, s]));
    expect(byId.a).toMatchObject({ status: 'parked', parkedUntil: until });
    expect(byId.a?.plan).toBeUndefined(); // signed out: the status names no plan
    expect(byId.b).toMatchObject({ status: 'parked', parkedUntil: until, plan: 'max' });
  });

  it('a park that lands while the plan-only check runs is kept, and so is the plan', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (markStarted = r));
    /** The real Claude lane, its status run replaced by a gate (no process is started). */
    class GatedClaude extends CliLane {
      override async checkAuth(
        _p: Profile,
        _v?: unknown,
        detail?: { plan?: string },
      ): Promise<'ok' | 'unauthenticated' | 'unknown'> {
        markStarted();
        await gate;
        if (detail) detail.plan = 'max';
        return 'unauthenticated'; // a serving account's verdict must be ignored
      }
    }
    iron.registry.addLane('anthropic', new GatedClaude({ ...claudeSpec, binary: FAKE }));
    const p = await put('a', { state: { status: 'active', served: 2 } });
    const refresh = iron.refreshStatus('a');
    await started;
    const until = iso(now + 3_600_000);
    await iron.router.park(p, { kind: 'quota-exhausted', source: 'status', resetAt: until });
    release();
    await refresh;
    expect((await iron.allStates()).a).toMatchObject({
      status: 'parked',
      parkedUntil: until,
      served: 2,
      plan: 'max',
      planSource: 'cli-status',
    });
  });

  it('a CLI whose status names no plan (Codex) is not run for a serving account', async () => {
    await put('o', { provider: 'openai', state: { status: 'active' } });
    await iron.refreshStatus('o');
    expect(await runs('o')).toBe(0);
  });

  it('a parked account on a lane nothing here can run does not break the refresh', async () => {
    const until = iso(now + 3_600_000);
    await iron.profiles.put({
      id: 'x',
      title: 'T x',
      provider: 'anthropic',
      lane: 'oauth',
      order: 0,
      enabled: true,
      createdAt: '',
      updatedAt: '',
      oauth: { secretRef: 'oauth:x', extension: 'none-registered' },
    });
    await iron.states.put({ profileId: 'x', status: 'parked', served: 0, parkedUntil: until });
    const [st] = await iron.refreshStatus('x');
    expect(st).toMatchObject({ status: 'parked', parkedUntil: until });
    expect(st?.plan).toBeUndefined();
  });

  it('a plan reader that throws never changes the sign-in verdict', async () => {
    const lane = new CliLane({
      ...claudeSpec,
      binary: FAKE,
      status: {
        ...claudeSpec.status!,
        plan: () => {
          throw new Error('unexpected output');
        },
      },
    });
    const p = await put('a', { plan: 'max' });
    const detail: { plan?: string } = {};
    expect(await lane.checkAuth(p, undefined, detail)).toBe('ok');
    expect(detail).toEqual({});
  });
});

describe('signing out forgets the plan and windows', () => {
  it('logout drops plan, planSource, planAt and windows', async () => {
    await put('a');
    await iron.reportFinished('a', {
      headers: claudeHeaders('0.5', '0.2', now + 60_000, now + 86_400_000),
      rateLimits: { planType: 'max' },
    });
    expect((await iron.allStates()).a).toMatchObject({ plan: 'max', windows: [{}, {}] });
    await iron.logout('a');
    const st = (await iron.allStates()).a!;
    expect(st.status).toBe('unauthenticated');
    for (const k of ['plan', 'planSource', 'planAt', 'windows'] as const)
      expect(st[k]).toBeUndefined();
  });

  it('a completed sign-in drops them too (it may be another subscription)', async () => {
    /** A lane whose login completes at once, in process. */
    const lane: Lane = {
      kind: 'cli',
      complete: async () => {
        throw new Error('unused');
      },
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error('unused');
      },
      checkAuth: async () => 'ok',
      login: (p: Profile) => ({
        profileId: p.id,
        done: Promise.resolve(),
        cancel: () => {},
        on: () => () => {},
      }),
    };
    iron.registry.addLane('anthropic', lane);
    await put('a');
    await iron.reportFinished('a', {
      headers: claudeHeaders('0.5', '0.2', now + 60_000, now + 86_400_000),
      rateLimits: { planType: 'max' },
    });
    const session = await iron.login('a');
    await session.done;
    for (let i = 0; i < 20 && (await iron.allStates()).a?.status !== 'ready'; i++)
      await new Promise((r) => setTimeout(r, 5));
    const st = (await iron.allStates()).a!;
    expect(st.status).toBe('ready');
    for (const k of ['plan', 'planSource', 'planAt', 'windows'] as const)
      expect(st[k]).toBeUndefined();
  });
});
