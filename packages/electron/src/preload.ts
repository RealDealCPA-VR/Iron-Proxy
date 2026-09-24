import type { IronClient, IronEvent, SerializedError } from '@iron-proxy/core';
import {
  channels,
  DEFAULT_CHANNEL_PREFIX,
  type ContextBridgeLike,
  type IpcRendererEventLike,
  type IpcRendererLike,
} from './electron-types.js';

/** Error rethrown in the renderer, carrying the manager's code. */
export class IronBridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  /** What the user should do next, when the manager said. */
  readonly hint: string | undefined;
  constructor(e: SerializedError) {
    super(e.message);
    this.name = e.name || 'IronProxyError';
    this.code = e.code;
    this.retryable = e.retryable;
    this.details = e.details ?? {};
    this.hint = typeof e.hint === 'string' && e.hint ? e.hint : undefined;
  }
}

export interface ExposeIronProxyOptions {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
  channelPrefix?: string;
  /** Property name on `window`. Default `ironProxy`. */
  globalName?: string;
}

const METHODS = [
  'providers',
  'listProfiles',
  'states',
  'createProfile',
  'updateProfile',
  'deleteProfile',
  'reorder',
  'activate',
  'setApiKey',
  'login',
  'cancelLogin',
  'loginCommand',
  'logout',
  'refreshStatus',
  'unpark',
  'listModels',
  'doctor',
  'discoverLogins',
  'adoptLogin',
] as const;

/** Build the IronClient implementation the preload exposes. Exported for tests. */
export function createBridgeClient(
  ipcRenderer: IpcRendererLike,
  channelPrefix: string = DEFAULT_CHANNEL_PREFIX,
): IronClient {
  const ch = channels(channelPrefix);
  const client: Record<string, unknown> = {};
  for (const name of METHODS) {
    client[name] = async (...args: unknown[]) => {
      const result = await ipcRenderer.invoke(ch.call, name, ...args);
      if (typeof result === 'object' && result !== null && '__ironError' in result) {
        throw new IronBridgeError((result as { __ironError: SerializedError }).__ironError);
      }
      return result === null ? undefined : result;
    };
  }
  let subscribed = 0;
  client.onEvent = (listener: (event: IronEvent) => void) => {
    const handler = (_e: IpcRendererEventLike, event: unknown) => listener(event as IronEvent);
    ipcRenderer.on(ch.event, handler);
    if (subscribed++ === 0) ipcRenderer.send(ch.subscribe);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener(ch.event, handler);
      if (--subscribed === 0) ipcRenderer.send(ch.unsubscribe);
    };
  };
  return client as unknown as IronClient;
}

/**
 * Call from the preload script:
 *
 *   import { contextBridge, ipcRenderer } from 'electron';
 *   import { exposeIronProxy } from '@iron-proxy/electron/preload';
 *   exposeIronProxy({ contextBridge, ipcRenderer });
 *
 * The renderer then finds a full IronClient at `window.ironProxy`.
 */
export function exposeIronProxy(opts: ExposeIronProxyOptions): IronClient {
  const client = createBridgeClient(opts.ipcRenderer, opts.channelPrefix);
  opts.contextBridge.exposeInMainWorld(opts.globalName ?? 'ironProxy', client);
  return client;
}
