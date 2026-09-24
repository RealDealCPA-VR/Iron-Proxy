import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIronProxy,
  MemoryProfileStore,
  MemoryStateStore,
  MemoryVault,
  type IronEvent,
} from '@iron-proxy/core';
import { installIronProxy, isIronIpcError } from '../src/ipc.js';
import type {
  IpcMainInvokeEventLike,
  IpcMainLike,
  WebContentsLike,
} from '../src/electron-types.js';

function fakeIpcMain() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown
  >();
  const listeners = new Map<
    string,
    Set<(event: IpcMainInvokeEventLike, ...args: unknown[]) => void>
  >();
  const ipcMain: IpcMainLike = {
    handle: (ch, fn) => void handlers.set(ch, fn),
    removeHandler: (ch) => void handlers.delete(ch),
    on: (ch, fn) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(fn);
    },
    removeListener: (ch, fn) => void listeners.get(ch)?.delete(fn),
  };
  return {
    ipcMain,
    invoke: (ch: string, sender: WebContentsLike, ...args: unknown[]) =>
      handlers.get(ch)!({ sender }, ...args),
    emit: (ch: string, sender: WebContentsLike, ...args: unknown[]) => {
      for (const fn of listeners.get(ch) ?? []) fn({ sender }, ...args);
    },
    handlers,
    listeners,
  };
}

function fakeWebContents(id: number) {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  let destroyed = false;
  const destroyListeners: Array<() => void> = [];
  const wc: WebContentsLike = {
    id,
    send: (channel, ...args) => void sent.push({ channel, args }),
    isDestroyed: () => destroyed,
    once: (_e, l) => void destroyListeners.push(l),
  };
  return {
    wc,
    sent,
    destroy() {
      destroyed = true;
      for (const l of destroyListeners) l();
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-electron-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('installIronProxy', () => {
  it('dispatches whitelisted methods, rejects unknown ones, and serialises errors', async () => {
    const iron = createIronProxy({
      dataDir: dir,
      profiles: new MemoryProfileStore(),
      states: new MemoryStateStore(),
      vault: new MemoryVault(),
      // No vendor CLI homes under this fake user, so discovery never touches the real ~.
      env: { HOME: dir, USERPROFILE: dir },
    });
    const { ipcMain, invoke, handlers, listeners } = fakeIpcMain();
    const install = installIronProxy({ ipcMain, iron });
    const sender = fakeWebContents(1).wc;

    expect(handlers.has('iron-proxy:call')).toBe(true);
    const providers = (await invoke('iron-proxy:call', sender, 'providers')) as Array<{
      id: string;
    }>;
    expect(providers.map((p) => p.id)).toContain('anthropic');

    const created = (await invoke('iron-proxy:call', sender, 'createProfile', {
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'k',
    })) as { id: string };
    expect((await iron.listProfiles()).map((p) => p.id)).toEqual([created.id]);

    // void results come back as null (structured-clone friendly)
    expect(await invoke('iron-proxy:call', sender, 'unpark', created.id)).toBeNull();

    const bad = await invoke('iron-proxy:call', sender, 'getProfile', 'x');
    expect(isIronIpcError(bad)).toBe(true);
    expect((bad as { __ironError: { code: string } }).__ironError.code).toBe('UNSUPPORTED');

    const notFound = await invoke('iron-proxy:call', sender, 'updateProfile', 'nope', {
      title: 'x',
    });
    expect(isIronIpcError(notFound)).toBe(true);
    expect(
      (notFound as { __ironError: { code: string; message: string } }).__ironError,
    ).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    expect((notFound as { __ironError: { hint?: string } }).__ironError.hint).toMatch(
      /iron-proxy profiles list/,
    );

    // The two existing-login methods ride the same whitelist (IRON_CLIENT_METHODS).
    expect(await invoke('iron-proxy:call', sender, 'discoverLogins')).toEqual([]);
    const noHome = await invoke('iron-proxy:call', sender, 'adoptLogin', {
      provider: 'anthropic',
      home: join(dir, 'missing'),
    });
    expect(isIronIpcError(noHome)).toBe(true);
    expect((noHome as { __ironError: { code: string; hint?: string } }).__ironError).toMatchObject({
      code: 'INVALID_REQUEST',
      hint: expect.stringContaining('--home'),
    });

    install.dispose();
    expect(handlers.has('iron-proxy:call')).toBe(false);
    expect([...(listeners.get('iron-proxy:subscribe') ?? [])]).toHaveLength(0);
    await iron.close();
  });

  it('forwards events only to subscribed renderers and drops destroyed ones', async () => {
    const iron = createIronProxy({
      dataDir: dir,
      profiles: new MemoryProfileStore(),
      states: new MemoryStateStore(),
      vault: new MemoryVault(),
    });
    const { ipcMain, emit } = fakeIpcMain();
    const install = installIronProxy({ ipcMain, iron, channelPrefix: 'custom' });
    const a = fakeWebContents(1);
    const b = fakeWebContents(2);
    emit('custom:subscribe', a.wc);
    emit('custom:subscribe', a.wc); // idempotent
    expect(install.subscriberCount()).toBe(1);

    await iron.createProfile({
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'k',
    });
    const created = a.sent.filter(
      (s) => s.channel === 'custom:event' && (s.args[0] as IronEvent).type === 'profile.created',
    );
    expect(created).toHaveLength(1);
    expect(b.sent).toHaveLength(0);

    a.destroy();
    expect(install.subscriberCount()).toBe(0);
    emit('custom:subscribe', b.wc);
    emit('custom:unsubscribe', b.wc);
    expect(install.subscriberCount()).toBe(0);
    install.dispose();
    await iron.close();
  });
});
