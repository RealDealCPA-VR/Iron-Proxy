import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AllProfilesExhaustedError,
  AuthRequiredError,
  createIronProxy,
  IronProxyError,
  MemoryProfileStore,
  MemoryStateStore,
  MemoryVault,
  NoProfileError,
  which,
  type IronEvent,
  type IronProxy,
  type LaneKind,
  type Profile,
  type ProviderId,
} from '../src/index.js';

let dir: string;
let iron: IronProxy;
let now: number;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-pick-'));
  now = Date.parse('2026-09-24T12:00:00Z');
  iron = createIronProxy({
    dataDir: dir,
    profiles: new MemoryProfileStore(),
    states: new MemoryStateStore(),
    vault: new MemoryVault(),
    clock: { now: () => now },
  });
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

/** Put a profile straight into the store, so no background status check races the test. */
async function put(
  id: string,
  order: number,
  extra: { provider?: ProviderId; lane?: LaneKind; enabled?: boolean } = {},
): Promise<Profile> {
  const lane = extra.lane ?? 'cli';
  const p: Profile = {
    id,
    title: `T ${id}`,
    provider: extra.provider ?? 'anthropic',
    lane,
    order,
    enabled: extra.enabled ?? true,
    createdAt: '',
    updatedAt: '',
    ...(lane === 'cli' ? { cli: { home: join(dir, id) } } : { apiKey: { secretRef: `k:${id}` } }),
  };
  await iron.profiles.put(p);
  return p;
}

async function setState(
  id: string,
  status: 'ready' | 'parked' | 'unauthenticated',
  until?: string,
) {
  await iron.states.put({
    profileId: id,
    status,
    served: 0,
    ...(until ? { parkedUntil: until } : {}),
  });
}

const later = (ms: number) => new Date(now + ms).toISOString();

describe('IronProxy.pickProfile', () => {
  it('returns the lowest-order enabled, ready cli account, skipping disabled and api-key ones', async () => {
    await put('key', 0, { lane: 'api-key' });
    await put('off', 1, { enabled: false });
    await put('b', 3);
    await put('a', 2);
    await put('other', 0, { provider: 'openai' });
    expect((await iron.pickProfile('anthropic')).id).toBe('a');
    expect((await iron.pickProfile('anthropic', { lane: 'any' })).id).toBe('key');
    expect((await iron.pickProfile('openai')).id).toBe('other');
  });

  it('skips parked and signed-out accounts, and clears an expired park like the router', async () => {
    await put('a', 0);
    await put('b', 1);
    await put('c', 2);
    await setState('a', 'parked', later(60_000));
    await setState('b', 'unauthenticated');
    expect((await iron.pickProfile('anthropic')).id).toBe('c');

    const events: IronEvent[] = [];
    iron.events.onAny((e) => events.push(e));
    now += 61_000;
    expect((await iron.pickProfile('anthropic')).id).toBe('a');
    expect((await iron.allStates()).a).toMatchObject({ status: 'ready' });
    expect((await iron.allStates()).a?.parkedUntil).toBeUndefined();
    expect(events).toContainEqual({ type: 'profile.unparked', profileId: 'a' });
  });

  it('throws AllProfilesExhaustedError with the earliest reset when the rest are parked', async () => {
    await put('a', 0);
    await put('b', 1);
    await put('c', 2);
    await setState('a', 'parked', later(3_600_000));
    await setState('b', 'parked', later(600_000));
    await setState('c', 'unauthenticated');
    const e = await iron.pickProfile('anthropic').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AllProfilesExhaustedError);
    expect((e as AllProfilesExhaustedError).earliestResetAt).toBe(later(600_000));
    expect((e as AllProfilesExhaustedError).hint).toContain('add another anthropic account');
  });

  it('throws AuthRequiredError naming the first signed-out account when all are signed out', async () => {
    await put('a', 0);
    await put('b', 1);
    await setState('a', 'unauthenticated');
    await setState('b', 'unauthenticated');
    const e = await iron.pickProfile('anthropic').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AuthRequiredError);
    expect((e as AuthRequiredError).hint).toBe(
      'Log "T a" in again: iron-proxy login a, or \'Log in\' on it in the switcher.',
    );
  });

  it('throws NoProfileError when the provider has no cli account', async () => {
    await put('key', 0, { lane: 'api-key' });
    await expect(iron.pickProfile('anthropic')).rejects.toBeInstanceOf(NoProfileError);
    await expect(iron.pickProfile('google')).rejects.toBeInstanceOf(NoProfileError);
  });

  it('with profileId returns that account, or INVALID_REQUEST when it is not a cli account of the provider', async () => {
    await put('a', 0);
    await put('b', 1);
    await put('key', 2, { lane: 'api-key' });
    await put('o', 0, { provider: 'openai' });
    await put('off', 3, { enabled: false });
    await setState('b', 'parked', later(60_000));
    expect((await iron.pickProfile('anthropic', { profileId: 'b' })).id).toBe('b');
    for (const profileId of ['key', 'o', 'off']) {
      const e = await iron.pickProfile('anthropic', { profileId }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(IronProxyError);
      expect((e as IronProxyError).code).toBe('INVALID_REQUEST');
    }
    await expect(iron.pickProfile('anthropic', { profileId: 'nope' })).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
    });
  });

  it('interactiveCommand and shellEnv use the scrubbed lane env and never expose PATH or API keys', async () => {
    const p = await put('a', 0);
    p.cli!.env = { FAKE_EXTRA: 'x', ANTHROPIC_API_KEY: 'sk-ant-should-be-stripped', PATH: '/evil' };
    await iron.profiles.put(p);
    const cmd = await iron.interactiveCommand('a', ['--resume']);
    expect(cmd.binary).toBe('claude');
    expect(cmd.args).toEqual(['--resume']);
    expect(cmd.env.CLAUDE_CONFIG_DIR).toBe(join(dir, 'a'));
    expect(cmd.env.ANTHROPIC_API_KEY).toBeUndefined();
    const sh = await iron.shellEnv('a');
    expect(sh.set).toEqual({ CLAUDE_CONFIG_DIR: join(dir, 'a'), FAKE_EXTRA: 'x' });
    expect(sh.unset).toContain('ANTHROPIC_API_KEY');
    expect(sh.unset).toContain('OPENAI_API_KEY');
    await put('key', 1, { lane: 'api-key' });
    await expect(iron.shellEnv('key')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});

describe.runIf(process.platform === 'win32')('which on Windows', () => {
  it('prefers a PATHEXT shim over the extensionless sh script npm installs beside it', async () => {
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'fakevendor'), '#!/bin/sh\n');
    await writeFile(join(bin, 'fakevendor.cmd'), '@echo off\r\n');
    const saved = process.env.PATH; // process.env is case-insensitive on Windows
    process.env.PATH = bin;
    try {
      expect((await which('fakevendor'))?.toLowerCase()).toBe(
        join(bin, 'fakevendor.cmd').toLowerCase(),
      );
      expect(await which('fakevendor.cmd')).toBe(join(bin, 'fakevendor.cmd'));
    } finally {
      process.env.PATH = saved;
    }
  });
});
