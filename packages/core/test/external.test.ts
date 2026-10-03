import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIronProxy,
  MemoryProfileStore,
  MemoryStateStore,
  MemoryUsageStore,
  MemoryVault,
  type IronEvent,
  type IronProxy,
  type Profile,
} from '../src/index.js';

/**
 * The external-executor API: a host runs the vendor CLI as the account
 * `pickProfile` chose, then reports what happened. Driven through the real
 * manager and router (no stubs), with memory stores and a fixed clock.
 */

let dir: string;
let iron: IronProxy;
let now: number;
let events: IronEvent[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-external-'));
  now = Date.parse('2026-10-03T12:00:00Z');
  iron = createIronProxy({
    dataDir: dir,
    profiles: new MemoryProfileStore(),
    states: new MemoryStateStore(),
    usage: new MemoryUsageStore(),
    vault: new MemoryVault(),
    clock: { now: () => now },
  });
  events = [];
  iron.events.onAny((e) => events.push(e));
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

async function put(id: string, order: number): Promise<Profile> {
  const p: Profile = {
    id,
    title: `T ${id}`,
    provider: 'anthropic',
    lane: 'cli',
    order,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    cli: { home: join(dir, id) },
  };
  await iron.profiles.put(p);
  await iron.states.put({ profileId: id, status: 'ready', served: 0 });
  return p;
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('IronProxy.reportSignal', () => {
  it('parks until the Anthropic reset instant on a 429, through the router park path', async () => {
    await put('a', 0);
    const reset = iso(now + 2 * 3_600_000);
    const r = await iron.reportSignal('a', {
      status: 429,
      headers: { 'anthropic-ratelimit-unified-reset': reset, 'retry-after': '60' },
      text: '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
    });
    expect(r.parked).toBe(true);
    if (!r.parked) throw new Error('unreachable');
    expect(r.signal).toMatchObject({ kind: 'rate-limit', resetAt: reset });
    expect(r.state).toMatchObject({ status: 'parked', parkedUntil: reset });
    expect((await iron.allStates()).a).toMatchObject({ status: 'parked', parkedUntil: reset });
    expect(events).toContainEqual({
      type: 'profile.parked',
      profileId: 'a',
      reason: r.signal,
      until: reset,
    });
    const [report] = await iron.usageReport({ profileId: 'a' });
    expect(report?.parks7d).toBe(1);
    expect((await iron.usage.history('a')).parks).toEqual([
      { at: iso(now), kind: 'rate-limit', until: reset },
    ]);
  });

  it('parks quota-exhausted on the CLI usage-limit text when no status is given', async () => {
    await put('a', 0);
    const r = await iron.reportSignal('a', {
      text: "Claude AI usage limit reached. You've hit your limit, resets 3pm",
    });
    expect(r.parked).toBe(true);
    if (!r.parked) throw new Error('unreachable');
    expect(r.signal.kind).toBe('quota-exhausted');
    expect(r.signal.source).toBe('cli-output');
    expect(r.state.status).toBe('parked');
    expect(Date.parse(r.state.parkedUntil!)).toBeGreaterThan(now);
  });

  it('does not park on a model-access 403: the account is healthy', async () => {
    await put('a', 0);
    for (const text of [
      '{"type":"error","error":{"type":"permission_error","message":"Your account does not have access to this model."}}',
      '{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}',
    ]) {
      expect(await iron.reportSignal('a', { status: 403, text })).toEqual({ parked: false });
    }
    expect((await iron.allStates()).a?.status).toBe('ready');
    expect(events.filter((e) => e.type === 'profile.parked')).toEqual([]);
    expect((await iron.pickProfile('anthropic')).id).toBe('a');
  });

  it('a 401 leaves the account needing sign-in, the state an internal auth signal produces', async () => {
    await put('a', 0);
    await put('b', 1);
    const r = await iron.reportSignal('a', {
      status: 401,
      text: '{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
    });
    expect(r.parked).toBe(true);
    if (!r.parked) throw new Error('unreachable');
    expect(r.signal.kind).toBe('auth-expired');
    expect(r.state.status).toBe('unauthenticated');
    expect(r.state.parkedUntil).toBeUndefined();
    // The next pick skips it; with no other account it is AUTH_REQUIRED naming it.
    expect((await iron.pickProfile('anthropic')).id).toBe('b');
    await iron.reportSignal('b', { status: 401, text: 'unauthorized' });
    await expect(iron.pickProfile('anthropic')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      details: { profileId: 'a', title: 'T a' },
    });
  });

  it('a plain error parks nothing; secrets in the reported text never reach the signal', async () => {
    await put('a', 0);
    expect(await iron.reportSignal('a', { status: 400, text: 'bad request' })).toEqual({
      parked: false,
    });
    expect(await iron.reportSignal('a', { text: 'Error: file not found' })).toEqual({
      parked: false,
    });
    const r = await iron.reportSignal('a', {
      status: 429,
      text: 'limited for key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
    });
    if (!r.parked) throw new Error('expected a park');
    expect(r.signal.message).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(events)).not.toContain('abcdefghijklmnop');
  });

  it('rejects bad input with INVALID_REQUEST and an unknown profile with PROFILE_NOT_FOUND', async () => {
    await put('a', 0);
    for (const bad of [
      {},
      { status: 99 },
      { status: 429.5 },
      { status: '429' },
      { text: 7 },
      { status: 429, headers: { 'retry-after': 60 } },
      { status: 429, headers: ['x'] },
      { text: '   ' },
    ]) {
      await expect(iron.reportSignal('a', bad as never)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    }
    await expect(iron.reportSignal('nope', { status: 429 })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
  });
});

describe('IronProxy.reportFinished', () => {
  it('records the external success exactly like an internal one', async () => {
    await put('a', 0);
    const state = await iron.reportFinished('a', {
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 9 },
      durationMs: 2500,
      model: 'claude-sonnet-5',
    });
    expect(state).toMatchObject({ status: 'active', served: 1, lastUsedAt: iso(now) });
    expect(iron.activeProfileId('anthropic')).toBe('a');
    const finished = events.find((e) => e.type === 'request.finished');
    expect(finished).toMatchObject({
      type: 'request.finished',
      provider: 'anthropic',
      profileId: 'a',
      durationMs: 2500,
      usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 9 },
      model: 'claude-sonnet-5',
    });
    expect(events).toContainEqual({
      type: 'profile.switched',
      provider: 'anthropic',
      toProfileId: 'a',
    });
    expect((await iron.reportFinished('a')).served).toBe(2);
    await iron.usageReport(); // waits for the usage writes
    expect((await iron.usage.history('a')).requests).toEqual([
      { at: iso(now), durationMs: 2500, inputTokens: 120, outputTokens: 40, cacheReadTokens: 9 },
      { at: iso(now), durationMs: 0 },
    ]);
  });

  it('a switch away from a parked account carries that park as the reason', async () => {
    await put('a', 0);
    await put('b', 1);
    await iron.reportFinished('a');
    const r = await iron.reportSignal('a', { status: 429, text: 'limited' });
    if (!r.parked) throw new Error('expected a park');
    await iron.reportFinished('b');
    expect(events).toContainEqual({
      type: 'profile.switched',
      provider: 'anthropic',
      fromProfileId: 'a',
      toProfileId: 'b',
      reason: r.signal,
    });
    expect(iron.activeProfileId('anthropic')).toBe('b');
  });

  it('rejects bad input with INVALID_REQUEST', async () => {
    await put('a', 0);
    for (const bad of [
      { usage: { inputTokens: 1 } },
      { usage: { inputTokens: -1, outputTokens: 1 } },
      { usage: { inputTokens: 1, outputTokens: 1.5 } },
      { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 'x' } },
      { durationMs: -5 },
      { model: 3 },
      [],
    ]) {
      await expect(iron.reportFinished('a', bad as never)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
    }
    expect((await iron.allStates()).a?.served).toBe(0);
  });
});
