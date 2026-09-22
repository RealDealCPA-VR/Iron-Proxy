import { describe, expect, it } from 'vitest';
import type { IronEvent } from '@iron-proxy/core';
import { createBridgeClient, exposeIronProxy, IronBridgeError } from '../src/preload.js';
import type {
  ContextBridgeLike,
  IpcRendererEventLike,
  IpcRendererLike,
} from '../src/electron-types.js';

function fakeIpcRenderer(handler: (method: string, ...args: unknown[]) => unknown) {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<(e: IpcRendererEventLike, ...a: unknown[]) => void>>();
  const ipcRenderer: IpcRendererLike = {
    invoke: async (_ch, method, ...args) => handler(method as string, ...args),
    send: (channel, ...args) => void sent.push({ channel, args }),
    on: (ch, fn) => {
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch)!.add(fn);
    },
    removeListener: (ch, fn) => void listeners.get(ch)?.delete(fn),
  };
  return {
    ipcRenderer,
    sent,
    listeners,
    push: (ch: string, ...args: unknown[]) => {
      for (const fn of listeners.get(ch) ?? []) fn({}, ...args);
    },
  };
}

describe('preload bridge', () => {
  it('maps methods to invoke, unwraps null, and rethrows __ironError with its code', async () => {
    const calls: unknown[][] = [];
    const { ipcRenderer } = fakeIpcRenderer((method, ...args) => {
      calls.push([method, ...args]);
      if (method === 'listProfiles') return [{ id: 'p1' }];
      if (method === 'unpark') return null;
      if (method === 'deleteProfile')
        return {
          __ironError: {
            name: 'ProfileNotFoundError',
            code: 'PROFILE_NOT_FOUND',
            message: 'nope',
            retryable: false,
            details: { profileId: 'x' },
          },
        };
      return undefined;
    });
    const client = createBridgeClient(ipcRenderer);
    expect(await client.listProfiles()).toEqual([{ id: 'p1' }]);
    expect(await client.unpark('p1')).toBeUndefined();
    expect(calls).toEqual([['listProfiles'], ['unpark', 'p1']]);
    const err = await client.deleteProfile('x').catch((e) => e);
    expect(err).toBeInstanceOf(IronBridgeError);
    expect(err.code).toBe('PROFILE_NOT_FOUND');
    expect(err.details).toEqual({ profileId: 'x' });
    expect(err.message).toBe('nope');
  });

  it('subscribes once, delivers events, and unsubscribes when the last listener leaves', () => {
    const { ipcRenderer, sent, push, listeners } = fakeIpcRenderer(() => undefined);
    const client = createBridgeClient(ipcRenderer, 'pfx');
    const got: IronEvent[] = [];
    const off1 = client.onEvent((e) => got.push(e));
    const off2 = client.onEvent((e) => got.push(e));
    expect(sent).toEqual([{ channel: 'pfx:subscribe', args: [] }]);
    push('pfx:event', { type: 'profile.deleted', profileId: 'p' } satisfies IronEvent);
    expect(got).toHaveLength(2);
    off1();
    off1(); // idempotent
    expect(sent).toHaveLength(1);
    off2();
    expect(sent.at(-1)).toEqual({ channel: 'pfx:unsubscribe', args: [] });
    expect(listeners.get('pfx:event')?.size).toBe(0);
  });

  it('exposeIronProxy publishes the client on the main world', () => {
    const exposed: Record<string, unknown> = {};
    const contextBridge: ContextBridgeLike = {
      exposeInMainWorld: (k, api) => void (exposed[k] = api),
    };
    const { ipcRenderer } = fakeIpcRenderer(() => undefined);
    const client = exposeIronProxy({ contextBridge, ipcRenderer });
    expect(exposed.ironProxy).toBe(client);
    expect(typeof (exposed.ironProxy as { doctor: unknown }).doctor).toBe('function');
  });
});
