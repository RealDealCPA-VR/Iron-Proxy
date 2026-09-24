import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIronProxy, type IronProxy } from '../src/manager.js';
import { MemoryProfileStore } from '../src/store/profile-store.js';
import { MemoryStateStore } from '../src/store/state-store.js';
import {
  FileUsageStore,
  MemoryUsageStore,
  USAGE_MAX_AGE_MS,
  USAGE_MAX_RECORDS,
} from '../src/store/usage-store.js';
import { buildUsageReport, estimateTimeLeft } from '../src/usage/report.js';
import type { UsageSampleRecord } from '../src/types.js';
import { MemoryVault } from '../src/vault/vault.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-usage-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('usage store bounds', () => {
  it('prunes records older than 14 days on write', async () => {
    const clock = { t: T0, now: () => clock.t };
    const store = new MemoryUsageStore({ clock });
    await store.addRequest('a', { at: iso(T0 - 13 * DAY), durationMs: 5 });
    await store.addPark('a', { at: iso(T0 - 13 * DAY), kind: 'rate-limit' });
    await store.addSample('a', { at: iso(T0 - 13 * DAY), utilisation: 0.5 });
    expect((await store.history('a')).requests).toHaveLength(1);
    clock.t = T0 + 2 * DAY; // the old records are now 15 days old
    await store.addRequest('a', { at: iso(clock.t), durationMs: 7 });
    const h = await store.history('a');
    expect(h.requests.map((r) => r.durationMs)).toEqual([7]);
    expect(h.parks).toEqual([]);
    expect(h.samples).toEqual([]);
    expect(USAGE_MAX_AGE_MS).toBe(14 * DAY);
  });

  it('keeps at most 5000 records per profile, dropping the oldest across kinds', async () => {
    const clock = { t: T0, now: () => clock.t };
    const store = new MemoryUsageStore({ clock });
    for (let i = 0; i < 4000; i++)
      await store.addRequest('a', { at: iso(T0 - DAY + i * 1000), durationMs: i });
    for (let i = 0; i < 1003; i++)
      await store.addSample('a', { at: iso(T0 - DAY + (4000 + i) * 1000), utilisation: 0.1 });
    await store.addPark('b', { at: iso(T0), kind: 'billing' });
    const h = await store.history('a');
    expect(USAGE_MAX_RECORDS).toBe(5000);
    expect(h.requests.length + h.parks.length + h.samples.length).toBe(5000);
    expect(h.samples).toHaveLength(1003);
    expect(h.requests[0]?.durationMs).toBe(3); // 0, 1 and 2 were the oldest
    // Other profiles have their own budget.
    expect((await store.history('b')).parks).toHaveLength(1);
    // The oldest go first even when they are samples.
    const small = new MemoryUsageStore({ clock, maxRecordsPerProfile: 3 });
    await small.addSample('x', { at: iso(T0 - 3000), utilisation: 0.1 });
    await small.addRequest('x', { at: iso(T0 - 2000), durationMs: 1 });
    await small.addPark('x', { at: iso(T0 - 1000), kind: 'rate-limit' });
    await small.addRequest('x', { at: iso(T0), durationMs: 2 });
    const hx = await small.history('x');
    expect(hx.samples).toEqual([]);
    expect(hx.requests.map((r) => r.durationMs)).toEqual([1, 2]);
    expect(hx.parks).toHaveLength(1);
  });

  it('FileUsageStore writes usage.json atomically after a debounce, reloads it, and survives a corrupt file', async () => {
    const clock = { t: T0, now: () => clock.t };
    const store = new FileUsageStore(dir, { clock, debounceMs: 10_000 });
    expect(store.path).toBe(join(dir, 'usage.json'));
    await store.addRequest('a', { at: iso(T0), durationMs: 3, inputTokens: 10, outputTokens: 4 });
    await store.addSample('a', { at: iso(T0), utilisation: 0.25, resetAt: iso(T0 + HOUR) });
    // Debounced: nothing on disk yet.
    await expect(stat(store.path)).rejects.toThrow();
    await store.flush();
    const file = JSON.parse(await readFile(store.path, 'utf8'));
    expect(file.version).toBe(1);
    expect(file.profiles.a.requests[0]).toEqual({
      at: iso(T0),
      durationMs: 3,
      inputTokens: 10,
      outputTokens: 4,
    });
    const again = new FileUsageStore(dir, { clock });
    expect((await again.history('a')).samples[0]?.utilisation).toBe(0.25);
    await again.delete('a');
    await again.flush();
    expect(JSON.parse(await readFile(store.path, 'utf8')).profiles).toEqual({});

    await writeFile(store.path, '{not json', 'utf8');
    const broken = new FileUsageStore(dir, { clock });
    expect(await broken.history('a')).toEqual({ requests: [], parks: [], samples: [] });
    await broken.addPark('a', { at: iso(T0), kind: 'rate-limit' });
    await broken.flush();
    expect(JSON.parse(await readFile(store.path, 'utf8')).profiles.a.parks).toHaveLength(1);
  });
});

describe('usage report windows', () => {
  it('counts requests and tokens per window and parks this week with an injectable clock', () => {
    const now = T0;
    const report = buildUsageReport(
      'a',
      {
        requests: [
          { at: iso(now - 30 * MIN), durationMs: 1, inputTokens: 100, outputTokens: 10 },
          { at: iso(now - 3 * HOUR), durationMs: 1, inputTokens: 200, outputTokens: 20 },
          { at: iso(now - 20 * HOUR), durationMs: 1, inputTokens: 400 },
          { at: iso(now - 3 * DAY), durationMs: 1, outputTokens: 80 },
          { at: iso(now - 8 * DAY), durationMs: 1, inputTokens: 9999, outputTokens: 9999 },
          { at: iso(now + MIN), durationMs: 1, inputTokens: 5 }, // from the future: ignored
        ],
        parks: [
          { at: iso(now - 9 * DAY), kind: 'quota-exhausted' },
          { at: iso(now - 2 * DAY), kind: 'rate-limit', until: iso(now - 2 * DAY + HOUR) },
          { at: iso(now - 4 * HOUR), kind: 'overloaded' },
        ],
        samples: [],
      },
      now,
    );
    expect(report.windows['1h']).toEqual({ requests: 1, inputTokens: 100, outputTokens: 10 });
    expect(report.windows['5h']).toEqual({ requests: 2, inputTokens: 300, outputTokens: 30 });
    expect(report.windows['24h']).toEqual({ requests: 3, inputTokens: 700, outputTokens: 30 });
    expect(report.windows['7d']).toEqual({ requests: 4, inputTokens: 700, outputTokens: 110 });
    expect(report.parks7d).toBe(2);
    expect(report.lastParkedAt).toBe(iso(now - 4 * HOUR));
    expect(report).not.toHaveProperty('utilisation');
    expect(report).not.toHaveProperty('estimate');
  });
});

describe('time-left estimate', () => {
  const reset = iso(T0 + 5 * HOUR);
  const s = (minAgo: number, utilisation: number, resetAt: string | undefined = reset) =>
    ({
      at: iso(T0 - minAgo * MIN),
      utilisation,
      ...(resetAt ? { resetAt } : {}),
    }) as UsageSampleRecord;

  it('never estimates from fewer than three samples', () => {
    expect(estimateTimeLeft([], T0)).toBeUndefined();
    expect(estimateTimeLeft([s(10, 0.2), s(0, 0.4)], T0)).toBeUndefined();
    const r = buildUsageReport(
      'a',
      { requests: [], parks: [], samples: [s(5, 0.2), s(0, 0.4)] },
      T0,
    );
    expect(r.utilisation).toBe(0.4);
    expect(r.resetAt).toBe(reset);
    expect(r.estimate).toBeUndefined();
  });

  it('computes minutesLeft from a known slope, low confidence with few samples', () => {
    // 0.2 -> 0.3 -> 0.4 over ten minutes: 0.02 per minute; 0.6 left -> 30 minutes.
    expect(estimateTimeLeft([s(10, 0.2), s(5, 0.3), s(0, 0.4)], T0)).toEqual({
      minutesLeft: 30,
      basis: 'utilisation-trend',
      confidence: 'low',
    });
  });

  it('caps the estimate at the time until the reset', () => {
    const soon = iso(T0 + 10 * MIN);
    expect(
      estimateTimeLeft([s(10, 0.2, soon), s(5, 0.3, soon), s(0, 0.4, soon)], T0)?.minutesLeft,
    ).toBe(10);
  });

  it('gives no estimate for a flat or falling trend', () => {
    expect(estimateTimeLeft([s(10, 0.4), s(5, 0.4), s(0, 0.4)], T0)).toBeUndefined();
    expect(estimateTimeLeft([s(10, 0.5), s(5, 0.4), s(0, 0.3)], T0)).toBeUndefined();
  });

  it('is medium confidence with six samples spanning ten minutes, low otherwise', () => {
    const six = [10, 8, 6, 4, 2, 0].map((m, i) => s(m, 0.1 + i * 0.04));
    expect(estimateTimeLeft(six, T0)?.confidence).toBe('medium');
    // 0.02 per minute, 0.7 left -> 35 minutes.
    expect(estimateTimeLeft(six, T0)?.minutesLeft).toBe(35);
    const quick = [5, 4, 3, 2, 1, 0].map((m, i) => s(m, 0.1 + i * 0.02));
    expect(estimateTimeLeft(quick, T0)?.confidence).toBe('low');
  });

  it('uses only the current window: same resetAt, or the last hour without one', () => {
    const old = iso(T0 - MIN);
    // Two samples of the current window, three of an earlier one: no estimate.
    const mixed = [s(40, 0.1, old), s(35, 0.3, old), s(30, 0.5, old), s(5, 0.1), s(0, 0.2)];
    expect(estimateTimeLeft(mixed, T0)).toBeUndefined();
    // Without a resetAt, samples older than an hour do not count.
    const noReset = [s(90, 0.1, ''), s(70, 0.2, ''), s(10, 0.3, ''), s(0, 0.4, '')];
    expect(estimateTimeLeft(noReset, T0)).toBeUndefined();
    const recent = [s(20, 0.2, ''), s(10, 0.3, ''), s(0, 0.4, '')];
    expect(estimateTimeLeft(recent, T0)?.minutesLeft).toBe(60);
    // A window whose reset has passed is stale: no utilisation, no estimate.
    const past = iso(T0 - 1);
    const r = buildUsageReport(
      'a',
      { requests: [], parks: [], samples: [s(10, 0.2, past), s(5, 0.3, past), s(1, 0.4, past)] },
      T0,
    );
    expect(r.utilisation).toBeUndefined();
    expect(r.estimate).toBeUndefined();
  });
});

describe('IronProxy usage history, end to end through the real router', () => {
  let iron: IronProxy | undefined;
  afterEach(async () => {
    await iron?.close();
    iron = undefined;
  });

  it('records finished requests, parks and utilisation samples from Anthropic headers', async () => {
    const clock = { t: T0, now: () => clock.t };
    const reset = iso(T0 + 5 * HOUR);
    let aCalls = 0;
    const bodies: string[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ''));
      const key = new Headers(init?.headers as HeadersInit).get('x-api-key');
      if (key === 'key-A' && ++aCalls === 5)
        return new Response(
          '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
          {
            status: 429,
            headers: { 'anthropic-ratelimit-requests-reset': iso(clock.t + HOUR) },
          },
        );
      const remaining = key === 'key-A' ? 100 - aCalls * 10 : 99;
      return new Response(
        JSON.stringify({
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'claude-x',
          content: [{ type: 'text', text: 'model output text' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'anthropic-ratelimit-requests-limit': '100',
            'anthropic-ratelimit-requests-remaining': String(remaining),
            'anthropic-ratelimit-requests-reset': reset,
          },
        },
      );
    };
    iron = createIronProxy({
      dataDir: dir,
      profiles: new MemoryProfileStore(),
      states: new MemoryStateStore(),
      vault: new MemoryVault(),
      clock,
      fetch,
      policy: { overloadRetries: 0 },
    });
    const a = await iron.createProfile({
      title: 'Work',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-A',
    });
    const b = await iron.createProfile({
      title: 'Home',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-B',
    });
    const req = {
      model: 'claude-x',
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'prompt text' }] },
      ],
    };
    for (let i = 0; i < 4; i++) {
      const res = await iron.complete(req);
      expect(res.profileId).toBe(a.id);
      clock.t += 2 * MIN;
    }
    // Fifth call: A answers 429, is parked, and B serves.
    expect((await iron.complete(req)).profileId).toBe(b.id);

    const [ra, rb] = await iron.usageReport();
    expect(ra?.profileId).toBe(a.id);
    expect(ra?.windows['1h']).toEqual({ requests: 4, inputTokens: 40, outputTokens: 20 });
    expect(ra?.parks7d).toBe(1);
    expect(ra?.lastParkedAt).toBe(iso(clock.t));
    // Samples 0.1, 0.2, 0.3, 0.4 two minutes apart: 0.05 per minute, 0.6 left -> 12 minutes.
    expect(ra?.utilisation).toBeCloseTo(0.4);
    expect(ra?.resetAt).toBe(reset);
    expect(ra?.estimate).toEqual({
      minutesLeft: 12,
      basis: 'utilisation-trend',
      confidence: 'low',
    });
    expect(rb?.windows['7d'].requests).toBe(1);
    expect(rb?.estimate).toBeUndefined();
    expect(await iron.usageReport({ profileId: b.id })).toEqual([rb]);
    await expect(iron.usageReport({ profileId: 'nope' })).rejects.toThrow(/does not exist/);

    const history = await iron.usage.history(a.id);
    expect(history.requests[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
    });
    expect(history.parks[0]).toMatchObject({ kind: 'rate-limit', until: iso(clock.t + HOUR) });

    // close() flushes the file; it holds counts only: no key, prompt, output or title.
    await iron.close();
    iron = undefined;
    const text = await readFile(join(dir, 'usage.json'), 'utf8');
    expect(bodies.some((x) => x.includes('prompt text'))).toBe(true);
    for (const secret of [
      'key-A',
      'key-B',
      'prompt text',
      'model output text',
      'Work',
      'Home',
      '@',
    ])
      expect(text).not.toContain(secret);
    expect(Object.keys(JSON.parse(text).profiles).sort()).toEqual([a.id, b.id].sort());
  });

  it('uses an injected store and forgets a deleted profile', async () => {
    const clock = { t: T0, now: () => clock.t };
    const usage = new MemoryUsageStore({ clock });
    iron = createIronProxy({
      dataDir: dir,
      profiles: new MemoryProfileStore(),
      states: new MemoryStateStore(),
      vault: new MemoryVault(),
      usage,
      clock,
    });
    expect(iron.usage).toBe(usage);
    const p = await iron.createProfile({ title: 'X', provider: 'anthropic', lane: 'api-key' });
    await usage.addRequest(p.id, { at: iso(T0 - 2 * HOUR), durationMs: 1, inputTokens: 3 });
    const [r] = await iron.usageReport();
    expect(r?.windows['1h'].requests).toBe(0);
    expect(r?.windows['5h']).toEqual({ requests: 1, inputTokens: 3, outputTokens: 0 });
    await iron.deleteProfile(p.id);
    expect(await usage.all()).toEqual({});
    await iron.close();
    iron = undefined;
    await expect(stat(join(dir, 'usage.json'))).rejects.toThrow();
  });
});
