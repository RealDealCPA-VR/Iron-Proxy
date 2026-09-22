import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileProfileStore, MemoryProfileStore } from '../src/store/profile-store.js';
import { FileStateStore, MemoryStateStore } from '../src/store/state-store.js';
import type { Profile } from '../src/types.js';

const profile = (id: string, order = 0): Profile => ({
  id,
  title: `P ${id}`,
  provider: 'anthropic',
  lane: 'api-key',
  order,
  enabled: true,
  apiKey: { secretRef: `apikey:${id}` },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('profile stores', () => {
  it('memory store isolates copies', async () => {
    const s = new MemoryProfileStore();
    const p = profile('a');
    await s.put(p);
    p.title = 'mutated';
    expect((await s.get('a'))?.title).toBe('P a');
  });
  it('file store persists across instances and survives concurrent puts', async () => {
    const s = new FileProfileStore(dir);
    await Promise.all([s.put(profile('a', 0)), s.put(profile('b', 1)), s.put(profile('c', 2))]);
    await s.delete('b');
    const s2 = new FileProfileStore(dir);
    expect((await s2.list()).map((p) => p.id).sort()).toEqual(['a', 'c']);
    const raw = JSON.parse(await readFile(join(dir, 'profiles.json'), 'utf8')) as {
      version: number;
    };
    expect(raw.version).toBe(1);
  });
});

describe('state stores', () => {
  it('memory', async () => {
    const s = new MemoryStateStore();
    await s.put({ profileId: 'a', status: 'ready', served: 1 });
    expect((await s.all()).a?.served).toBe(1);
    await s.delete('a');
    expect(await s.get('a')).toBeUndefined();
  });
  it('file store debounces and flushes', async () => {
    const s = new FileStateStore(dir, { debounceMs: 20 });
    await s.put({
      profileId: 'a',
      status: 'parked',
      served: 3,
      parkedUntil: '2026-01-01T00:00:00.000Z',
    });
    await s.flush();
    const s2 = new FileStateStore(dir);
    expect((await s2.get('a'))?.parkedUntil).toBe('2026-01-01T00:00:00.000Z');
  });
});
