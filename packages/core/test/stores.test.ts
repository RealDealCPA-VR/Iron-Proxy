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
  it('file store sees what another process wrote, and a later write keeps it', async () => {
    // Two stores on one directory stand in for the tray app and the CLI.
    const tray = new FileProfileStore(dir);
    const cli = new FileProfileStore(dir);
    await tray.put(profile('a', 0));
    expect((await tray.list()).map((p) => p.id)).toEqual(['a']);
    await cli.put(profile('b', 1));
    expect((await tray.list()).map((p) => p.id).sort()).toEqual(['a', 'b']);
    await tray.put({ ...profile('a', 0), title: 'Renamed' });
    const onDisk = new FileProfileStore(dir);
    expect((await onDisk.list()).map((p) => `${p.id}:${p.title}`).sort()).toEqual([
      'a:Renamed',
      'b:P b',
    ]);
    await cli.delete('b');
    expect(await tray.get('b')).toBeUndefined();
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
  it('file store sees a park another process recorded; its own unsaved writes win only for their account', async () => {
    const tray = new FileStateStore(dir, { debounceMs: 10_000 });
    const serve = new FileStateStore(dir, { debounceMs: 10_000 });
    await tray.put({ profileId: 'a', status: 'ready', served: 0 });
    await tray.flush();
    expect((await tray.get('a'))?.status).toBe('ready');
    await serve.put({ profileId: 'a', status: 'parked', served: 1, parkedUntil: 'x' });
    await serve.flush();
    expect((await tray.get('a'))?.status).toBe('parked');
    // An unsaved write here wins over the file for its own account until it is
    // flushed; the other process's accounts still show, and the flush keeps them.
    await tray.put({ profileId: 'b', status: 'ready', served: 0 });
    await tray.put({ profileId: 'a', status: 'ready', served: 2 });
    await serve.put({ profileId: 'c', status: 'ready', served: 0 });
    await serve.flush();
    const seen = await tray.all();
    expect(Object.keys(seen).sort()).toEqual(['a', 'b', 'c']);
    expect(seen.a?.status).toBe('ready');
    await tray.flush();
    const onDisk = await new FileStateStore(dir).all();
    expect(Object.keys(onDisk).sort()).toEqual(['a', 'b', 'c']);
    expect(onDisk.a?.served).toBe(2);
  });

  it('file store deletes are applied on top of what another process wrote', async () => {
    const tray = new FileStateStore(dir, { debounceMs: 10_000 });
    const serve = new FileStateStore(dir, { debounceMs: 10_000 });
    await tray.put({ profileId: 'a', status: 'ready', served: 0 });
    await tray.put({ profileId: 'b', status: 'ready', served: 0 });
    await tray.flush();
    await serve.all(); // serve holds a and b
    await tray.delete('a');
    await tray.flush();
    await serve.put({ profileId: 'b', status: 'parked', served: 1 });
    await serve.flush();
    const onDisk = await new FileStateStore(dir).all();
    expect(Object.keys(onDisk)).toEqual(['b']);
    expect(onDisk.b?.status).toBe('parked');
  });
});

describe('telling own writes from another process', () => {
  it('externalWrites counts only versions another store wrote', async () => {
    const tray = new FileProfileStore(dir);
    const cli = new FileProfileStore(dir);
    await tray.list();
    expect(tray.externalWrites).toBe(0);
    await tray.put(profile('a'));
    await tray.put(profile('b'));
    await tray.list();
    expect(tray.externalWrites).toBe(0);
    await cli.put(profile('c'));
    expect(cli.externalWrites).toBe(1); // it read the tray's file before merging
    await tray.list();
    expect(tray.externalWrites).toBe(1);
    await tray.list();
    expect(tray.externalWrites).toBe(1);
    // A write that merges an unseen external version counts it too.
    await cli.put(profile('d'));
    await tray.put(profile('e'));
    expect(tray.externalWrites).toBe(2);

    const st = new FileStateStore(dir, { debounceMs: 1 });
    await st.put({ profileId: 'a', status: 'ready', served: 0 });
    await st.flush();
    await st.all();
    expect(st.externalWrites).toBe(0);
    const other = new FileStateStore(dir, { debounceMs: 1 });
    await other.put({ profileId: 'b', status: 'ready', served: 0 });
    await other.flush();
    await st.all();
    expect(st.externalWrites).toBe(1);
  });
});
