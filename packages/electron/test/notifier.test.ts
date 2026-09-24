import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIronProxy,
  MemoryUsageStore,
  type IronEvent,
  type IronProxy,
  type Profile,
  type ProviderId,
} from '@iron-proxy/core';
import {
  createNotifier,
  formatClockTime,
  notificationFor,
  type NotificationContext,
  type NotificationOptionsLike,
  type NotifierClock,
} from '../src/notifier.js';

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]+/i;
const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const RESET = '2026-09-24T15:40:00.000Z'; // 3:40 PM in UTC

const TITLES: Record<string, string> = { a: 'Work Claude', b: 'Home Claude', c: 'Spare GPT' };

function ctx(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    profileTitle: (id) => TITLES[id],
    providerName: (id) => ({ anthropic: 'Claude', openai: 'ChatGPT' })[id as string] ?? id,
    now: () => NOW,
    locale: 'en-US',
    timeZone: 'UTC',
    ...overrides,
  };
}

function profile(id: string, title: string, provider: ProviderId = 'anthropic'): Profile {
  return {
    id,
    title,
    provider,
    lane: 'api-key',
    order: 0,
    enabled: true,
    apiKey: { secretRef: `ref-${id}` },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Fake Electron Notification: records every shown notification. */
function fakeNotificationClass(supported = true) {
  const shown: NotificationOptionsLike[] = [];
  class FakeNotification {
    constructor(private readonly options: NotificationOptionsLike) {}
    static isSupported() {
      return supported;
    }
    show() {
      shown.push(this.options);
    }
  }
  return { Notification: FakeNotification, shown };
}

/** Fake clock with timers that fire when time is advanced. */
function fakeClock(start = NOW) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: NotifierClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((x, y) => x[1].at - y[1].at)) {
      if (t.at <= now && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { clock, advance, pending: () => timers.size };
}

/** An IronClient-shaped event source the test drives by hand. */
function fakeClient(profiles: Profile[]) {
  const listeners = new Set<(e: IronEvent) => void>();
  let listCalls = 0;
  return {
    client: {
      onEvent(l: (e: IronEvent) => void) {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      async listProfiles() {
        listCalls++;
        return profiles;
      },
    },
    emit: (e: IronEvent) => {
      for (const l of [...listeners]) l(e);
    },
    listenerCount: () => listeners.size,
    listCalls: () => listCalls,
  };
}

const rateLimit = { kind: 'rate-limit' as const, source: 'header' as const, resetAt: RESET };

describe('notificationFor', () => {
  it('maps an automatic switch with the reset time', () => {
    const n = notificationFor(
      {
        type: 'profile.switched',
        provider: 'anthropic',
        fromProfileId: 'a',
        toProfileId: 'b',
        reason: rateLimit,
      },
      ctx(),
    );
    expect(n).toEqual({
      kind: 'switched',
      title: 'Switched to "Home Claude"',
      body: '"Work Claude" hit its limit. Back at 3:40 PM.',
    });
  });

  it('uses the parked-until time when the reason carries none', () => {
    const n = notificationFor(
      {
        type: 'profile.switched',
        provider: 'anthropic',
        fromProfileId: 'a',
        toProfileId: 'b',
        reason: { kind: 'quota-exhausted', source: 'cli-output' },
      },
      ctx({ parkedUntil: (id) => (id === 'a' ? RESET : undefined) }),
    );
    expect(n?.body).toBe('"Work Claude" hit its limit. Back at 3:40 PM.');
  });

  it('maps a pre-emptive (usage) switch', () => {
    const n = notificationFor(
      {
        type: 'profile.switched',
        provider: 'anthropic',
        fromProfileId: 'a',
        toProfileId: 'b',
        reason: {
          kind: 'rate-limit',
          source: 'usage',
          message: 'Switched early: 96% of the window used, resets 3:40 PM',
          resetAt: RESET,
        },
      },
      ctx(),
    );
    expect(n).toEqual({
      kind: 'switched',
      title: 'Switched to "Home Claude"',
      body: '"Work Claude" switched early, 96% used. Resets at 3:40 PM.',
    });
  });

  it('is silent for a user-initiated switch (no reason)', () => {
    expect(
      notificationFor(
        { type: 'profile.switched', provider: 'anthropic', fromProfileId: 'a', toProfileId: 'b' },
        ctx(),
      ),
    ).toBeUndefined();
  });

  it('maps a park, and skips an overload park', () => {
    expect(
      notificationFor(
        { type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET },
        ctx(),
      ),
    ).toEqual({
      kind: 'parked',
      title: '"Work Claude" is resting',
      body: 'It hit its limit. Back at 3:40 PM.',
    });
    expect(
      notificationFor(
        {
          type: 'profile.parked',
          profileId: 'a',
          reason: { kind: 'overloaded', source: 'status' },
        },
        ctx(),
      ),
    ).toBeUndefined();
    expect(
      notificationFor(
        {
          type: 'profile.parked',
          profileId: 'a',
          reason: { kind: 'auth-expired', source: 'status' },
        },
        ctx(),
      )?.title,
    ).toBe('"Work Claude" needs to sign in again');
  });

  it('maps provider.exhausted', () => {
    expect(
      notificationFor(
        { type: 'provider.exhausted', provider: 'anthropic', earliestResetAt: RESET },
        ctx(),
      ),
    ).toEqual({
      kind: 'exhausted',
      title: 'All Claude accounts are resting',
      body: 'Earliest back at 3:40 PM. Add another Claude account to keep going.',
    });
  });

  it('maps login completed and failed, and ignores other login events', () => {
    expect(
      notificationFor({ type: 'login', event: { type: 'completed', profileId: 'c' } }, ctx()),
    ).toEqual({
      kind: 'login',
      title: 'Signed in: "Spare GPT"',
      body: 'The account is ready to use.',
    });
    const failed = notificationFor(
      {
        type: 'login',
        event: { type: 'failed', profileId: 'c', message: 'Login failed for jane@example.com' },
      },
      ctx(),
    );
    expect(failed?.title).toBe('Sign-in did not finish: "Spare GPT"');
    expect(JSON.stringify(failed)).not.toMatch(EMAIL);
    expect(
      notificationFor(
        { type: 'login', event: { type: 'started', profileId: 'c', method: 'cli' } },
        ctx(),
      ),
    ).toBeUndefined();
  });

  it('never puts an email or an id in the text, even when the title lookup fails', () => {
    const unknown = ctx({ profileTitle: () => undefined });
    const events: IronEvent[] = [
      {
        type: 'profile.switched',
        provider: 'anthropic',
        fromProfileId: 'prof_jane@example.com',
        toProfileId: 'prof_bob@example.com',
        reason: { ...rateLimit, message: 'limit reached for jane@example.com' },
      },
      {
        type: 'profile.parked',
        profileId: 'prof_jane@example.com',
        reason: { ...rateLimit, message: 'jane@example.com is out' },
        until: RESET,
      },
      {
        type: 'login',
        event: { type: 'failed', profileId: 'prof_jane@example.com', message: 'jane@example.com' },
      },
      { type: 'login', event: { type: 'completed', profileId: 'prof_jane@example.com' } },
    ];
    for (const e of events) {
      const n = notificationFor(e, unknown);
      expect(n).toBeDefined();
      const text = `${n!.title} ${n!.body}`;
      expect(text).not.toMatch(EMAIL);
      expect(text).not.toContain('prof_');
    }
    expect(notificationFor(events[0]!, unknown)?.title).toBe('Switched to another Claude account');
    // A title that is itself an email is redacted.
    const emailTitle = ctx({ profileTitle: () => 'jane@example.com' });
    expect(JSON.stringify(notificationFor(events[1]!, emailTitle))).not.toMatch(EMAIL);
  });

  it('formats a far-off reset with the weekday and drops a past one', () => {
    expect(formatClockTime('2026-09-26T15:40:00.000Z', NOW, 'en-US', 'UTC')).toBe('Sat 3:40 PM');
    expect(formatClockTime('2026-09-24T11:00:00.000Z', NOW, 'en-US', 'UTC')).toBeUndefined();
  });
});

describe('createNotifier', () => {
  const base = { locale: 'en-US', timeZone: 'UTC' };
  const profiles = [profile('a', 'Work Claude'), profile('b', 'Home Claude')];

  it('shows a mapped event through the injected Notification class', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const { clock } = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock });
    src.emit({ type: 'provider.exhausted', provider: 'anthropic', earliestResetAt: RESET });
    await n.settled();
    expect(shown).toEqual([
      {
        title: 'All Claude accounts are resting',
        body: 'Earliest back at 3:40 PM. Add another Claude account to keep going.',
        silent: false,
      },
    ]);
    n.dispose();
  });

  it('shows nothing when Notification.isSupported() is false', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass(false);
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: fakeClock().clock,
    });
    src.emit({ type: 'provider.exhausted', provider: 'anthropic' });
    await n.settled();
    expect(shown).toEqual([]);
    n.dispose();
  });

  it('coalesces a park followed by a switch into one notification', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock: t.clock });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    await n.settled();
    t.advance(1_500);
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: { kind: 'rate-limit', source: 'header' },
    });
    await n.settled();
    t.advance(10_000);
    expect(shown.map((s) => s.title)).toEqual(['Switched to "Home Claude"']);
    expect(shown[0]!.body).toBe('"Work Claude" hit its limit. Back at 3:40 PM.');
    n.dispose();
  });

  it('holds a park while the next account is answering, then shows only the switch', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock: t.clock });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    src.emit({ type: 'request.started', requestId: 'r1', provider: 'anthropic', profileId: 'b' });
    await n.settled();
    t.advance(30_000); // a slow answer on B
    expect(shown).toEqual([]);
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      toProfileId: 'b',
      reason: rateLimit,
    });
    src.emit({
      type: 'request.finished',
      requestId: 'r1',
      provider: 'anthropic',
      profileId: 'b',
      durationMs: 30_000,
    });
    await n.settled();
    t.advance(10_000);
    expect(shown).toHaveLength(1);
    // The park supplies the "from" account when the switch event has none.
    expect(shown[0]!.body).toBe('"Work Claude" hit its limit. Back at 3:40 PM.');
    n.dispose();
  });

  it('shows a park when no switch follows within 2s', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock: t.clock });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    await n.settled();
    t.advance(1_999);
    expect(shown).toEqual([]);
    t.advance(1);
    expect(shown.map((s) => s.title)).toEqual(['"Work Claude" is resting']);
    n.dispose();
  });

  it('shows a park held by an abandoned request once maxHoldMs has passed', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      maxHoldMs: 45_000,
    });
    src.emit({
      type: 'profile.parked',
      profileId: 'a',
      reason: { kind: 'auth-expired', source: 'status' },
    });
    // A request on B starts and is then abandoned (Stop button): no finished,
    // no failed, no switch ever follows.
    src.emit({ type: 'request.started', requestId: 'r1', provider: 'anthropic', profileId: 'b' });
    await n.settled();
    t.advance(44_999);
    expect(shown).toEqual([]);
    t.advance(1);
    expect(shown.map((s) => s.title)).toEqual(['"Work Claude" needs to sign in again']);
    t.advance(24 * 3_600_000);
    expect(shown).toHaveLength(1);
    expect(t.pending()).toBe(0);
    n.dispose();
  });

  it('replaces only the park of the account a switch came from', async () => {
    const src = fakeClient([...profiles, profile('c', 'Spare Claude')]);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock: t.clock });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    src.emit({
      type: 'profile.parked',
      profileId: 'c',
      reason: { kind: 'billing', source: 'status' },
    });
    await n.settled();
    t.advance(500);
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: rateLimit,
    });
    await n.settled();
    t.advance(10_000);
    expect(shown.map((s) => s.title)).toEqual([
      'Switched to "Home Claude"',
      '"Spare Claude" has a billing problem',
    ]);
    n.dispose();
  });

  it('without a from account, a switch replaces only the most recent park of the provider', async () => {
    const src = fakeClient([...profiles, profile('c', 'Spare Claude')]);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock: t.clock });
    src.emit({
      type: 'profile.parked',
      profileId: 'c',
      reason: { kind: 'billing', source: 'status' },
    });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    await n.settled();
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      toProfileId: 'b',
      reason: rateLimit,
    });
    await n.settled();
    t.advance(10_000);
    expect(shown.map((s) => [s.title, s.body])).toEqual([
      ['Switched to "Home Claude"', '"Work Claude" hit its limit. Back at 3:40 PM.'],
      ['"Spare Claude" has a billing problem', expect.any(String)],
    ]);
    n.dispose();
  });

  it('lets provider.exhausted replace the pending parks of that provider', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock: t.clock });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    src.emit({ type: 'profile.parked', profileId: 'b', reason: rateLimit, until: RESET });
    src.emit({ type: 'provider.exhausted', provider: 'anthropic', earliestResetAt: RESET });
    await n.settled();
    t.advance(5_000);
    expect(shown.map((s) => s.title)).toEqual(['All Claude accounts are resting']);
    n.dispose();
  });

  it('throttles identical (kind, account) notifications within throttleMs', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      throttleMs: 60_000,
    });
    const sw: IronEvent = {
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: rateLimit,
    };
    src.emit(sw);
    await n.settled();
    t.advance(30_000);
    src.emit(sw);
    // A different account is not throttled by the first one.
    src.emit({ ...sw, fromProfileId: 'b', toProfileId: 'a' });
    // A different incident landing on the same target (c -> b) still shows.
    src.emit({ ...sw, fromProfileId: 'c', toProfileId: 'b' });
    src.emit({ ...sw, fromProfileId: 'c', toProfileId: 'b' });
    await n.settled();
    expect(shown.map((s) => s.title)).toEqual([
      'Switched to "Home Claude"',
      'Switched to "Work Claude"',
      'Switched to "Home Claude"',
    ]);
    expect(shown[2]!.body).toBe('The previous Claude account hit its limit. Back at 3:40 PM.');
    t.advance(31_000);
    src.emit(sw);
    await n.settled();
    expect(shown).toHaveLength(4);
    n.dispose();
  });

  it('honours settings: a disabled kind, and everything off', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      settings: { kinds: { exhausted: false } },
    });
    src.emit({ type: 'provider.exhausted', provider: 'anthropic' });
    src.emit({ type: 'login', event: { type: 'completed', profileId: 'a' } });
    await n.settled();
    expect(shown.map((s) => s.title)).toEqual(['Signed in: "Work Claude"']);

    n.setSettings({ enabled: false });
    src.emit({ type: 'login', event: { type: 'failed', profileId: 'b', message: 'x' } });
    src.emit({ type: 'provider.exhausted', provider: 'openai' });
    await n.settled();
    expect(shown).toHaveLength(1);

    n.setSettings({ enabled: true });
    src.emit({ type: 'provider.exhausted', provider: 'openai' });
    await n.settled();
    expect(shown.map((s) => s.title)).toContain('All ChatGPT accounts are resting');
    n.dispose();
  });

  it('is silent for a user-initiated switch', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const onError = vi.fn();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      onError,
    });
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
    });
    await n.settled();
    t.advance(120_000);
    expect(shown).toEqual([]);
    // Silent because it was skipped, not because showing it failed.
    expect(onError).not.toHaveBeenCalled();
    n.dispose();
  });

  it('keeps a switch quiet when its park was already shown after maxHoldMs', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const onError = vi.fn();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      maxHoldMs: 45_000,
      throttleMs: 60_000,
      onError,
    });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    // A long stream on B: the park is held, then shown at maxHoldMs.
    src.emit({ type: 'request.started', requestId: 'r1', provider: 'anthropic', profileId: 'b' });
    await n.settled();
    t.advance(45_000);
    expect(shown.map((s) => s.title)).toEqual(['"Work Claude" is resting']);
    // The stream finishes 50 s after the park and the router announces the switch.
    t.advance(5_000);
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: rateLimit,
    });
    src.emit({
      type: 'request.finished',
      requestId: 'r1',
      provider: 'anthropic',
      profileId: 'b',
      durationMs: 50_000,
    });
    await n.settled();
    t.advance(10_000);
    expect(shown).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    n.dispose();
  });

  it('shows a switch that follows a park released after the plain coalesceMs wait', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      coalesceMs: 2_000,
      maxHoldMs: 45_000,
      throttleMs: 60_000,
    });
    // No request is waiting on another account: the park shows after coalesceMs.
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    await n.settled();
    t.advance(2_000);
    expect(shown.map((s) => s.title)).toEqual(['"Work Claude" is resting']);
    // A switch away from that account well within throttleMs is news, and shows.
    t.advance(10_000);
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: rateLimit,
    });
    await n.settled();
    expect(shown.map((s) => s.title)).toEqual([
      '"Work Claude" is resting',
      'Switched to "Home Claude"',
    ]);
    n.dispose();
  });

  it('a park released at coalesceMs clears an earlier capped one for the same account', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      coalesceMs: 2_000,
      maxHoldMs: 45_000,
      throttleMs: 60_000,
    });
    // First park: released by the maxHoldMs cap while a long stream runs on B.
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    src.emit({ type: 'request.started', requestId: 'r1', provider: 'anthropic', profileId: 'b' });
    await n.settled();
    t.advance(45_000);
    src.emit({
      type: 'request.finished',
      requestId: 'r1',
      provider: 'anthropic',
      profileId: 'b',
      durationMs: 45_000,
    });
    // A second park of the same account, released at coalesceMs (throttled as a
    // repeat, but it is no longer the capped park the late switch belongs to).
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    await n.settled();
    t.advance(2_000);
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: rateLimit,
    });
    await n.settled();
    expect(shown.map((s) => s.title)).toEqual([
      '"Work Claude" is resting',
      'Switched to "Home Claude"',
    ]);
    n.dispose();
  });

  it('keeps a late switch without a from account quiet too, and only once', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      maxHoldMs: 45_000,
      throttleMs: 60_000,
    });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    src.emit({ type: 'request.started', requestId: 'r1', provider: 'anthropic', profileId: 'b' });
    await n.settled();
    t.advance(45_000);
    const sw: IronEvent = {
      type: 'profile.switched',
      provider: 'anthropic',
      toProfileId: 'b',
      reason: rateLimit,
    };
    src.emit(sw);
    await n.settled();
    expect(shown).toHaveLength(1);
    // A later, separate switch is a new incident and shows.
    t.advance(1_000);
    src.emit({ ...sw, fromProfileId: 'b', toProfileId: 'a' });
    await n.settled();
    expect(shown.map((s) => s.title)).toEqual([
      '"Work Claude" is resting',
      'Switched to "Work Claude"',
    ]);
    n.dispose();
  });

  it('shows a late switch when its park was shown longer than throttleMs ago', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: t.clock,
      maxHoldMs: 45_000,
      throttleMs: 60_000,
    });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    src.emit({ type: 'request.started', requestId: 'r1', provider: 'anthropic', profileId: 'b' });
    await n.settled();
    t.advance(45_000);
    t.advance(60_000);
    src.emit({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: rateLimit,
    });
    await n.settled();
    expect(shown.map((s) => s.title)).toEqual([
      '"Work Claude" is resting',
      'Switched to "Home Claude"',
    ]);
    n.dispose();
  });

  it('keeps its title cache current from profile events and refreshes for unknown ids', async () => {
    const list = [...profiles];
    const src = fakeClient(list);
    const { Notification, shown } = fakeNotificationClass();
    const n = createNotifier({
      ...base,
      client: src.client,
      Notification,
      clock: fakeClock().clock,
    });
    await n.settled();
    expect(src.listCalls()).toBe(1);
    src.emit({ type: 'profile.updated', profile: profile('a', 'Renamed Claude') });
    src.emit({ type: 'login', event: { type: 'completed', profileId: 'a' } });
    await n.settled();
    expect(shown.at(-1)!.title).toBe('Signed in: "Renamed Claude"');
    expect(src.listCalls()).toBe(1);
    list.push(profile('z', 'Brand New'));
    src.emit({ type: 'login', event: { type: 'completed', profileId: 'z' } });
    await n.settled();
    expect(shown.at(-1)!.title).toBe('Signed in: "Brand New"');
    expect(src.listCalls()).toBe(2);
    n.dispose();
  });

  it('dispose unsubscribes and cancels a pending park', async () => {
    const src = fakeClient(profiles);
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock();
    const n = createNotifier({ ...base, client: src.client, Notification, clock: t.clock });
    src.emit({ type: 'profile.parked', profileId: 'a', reason: rateLimit, until: RESET });
    await n.settled();
    expect(src.listenerCount()).toBe(1);
    n.dispose();
    expect(src.listenerCount()).toBe(0);
    expect(t.pending()).toBe(0);
    t.advance(10_000);
    src.emit({ type: 'provider.exhausted', provider: 'anthropic' });
    await n.settled();
    expect(shown).toEqual([]);
  });
});

describe('createNotifier with a real IronProxy', () => {
  let dir: string | undefined;
  let iron: IronProxy | undefined;
  afterEach(async () => {
    await iron?.close();
    iron = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('turns a real failover into one "Switched to" notification with no email or key', async () => {
    dir = await mkdtemp(join(tmpdir(), 'iron-notify-'));
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    let aCalls = 0;
    const f: typeof fetch = async (_input, init) => {
      const key = new Headers(init?.headers as HeadersInit).get('x-api-key');
      if (key === 'key-A' && ++aCalls === 1) {
        return new Response(
          '{"type":"error","error":{"type":"rate_limit_error","message":"limited for jane@example.com"}}',
          {
            status: 429,
            headers: {
              'anthropic-ratelimit-requests-reset': reset,
              'content-type': 'application/json',
            },
          },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'claude-x',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    iron = createIronProxy({ dataDir: dir, fetch: f, usage: new MemoryUsageStore() });
    await iron.createProfile({
      title: 'Work Claude',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-A',
    });
    await iron.createProfile({
      title: 'Home Claude',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-B',
    });
    const { Notification, shown } = fakeNotificationClass();
    const t = fakeClock(Date.now());
    const onError = vi.fn();
    const n = createNotifier({ locale: 'en-US', iron, Notification, clock: t.clock, onError });
    const events: IronEvent[] = [];
    iron.events.onAny((e) => events.push(e));
    await iron.complete({
      model: 'claude-x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    await n.settled();
    t.advance(10_000);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Switched to "Home Claude"');
    expect(shown[0]!.body).toMatch(/^"Work Claude" hit its limit\. Back at \d{1,2}:\d{2} [AP]M\.$/);
    const text = JSON.stringify(shown);
    expect(text).not.toMatch(EMAIL);
    expect(text).not.toContain('key-');

    // The user's own choice is silent: activate the first account again and use it.
    const a = (await iron.listProfiles('anthropic')).find((p) => p.title === 'Work Claude')!;
    await iron.activate(a.id);
    await iron.complete({
      model: 'claude-x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }] }],
    });
    await n.settled();
    expect(events.filter((e) => e.type === 'profile.switched')).toHaveLength(2);
    t.advance(10_000);
    expect(shown).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    n.dispose();
  });
});
