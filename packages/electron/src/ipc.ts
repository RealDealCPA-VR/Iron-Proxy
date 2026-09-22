import {
  IRON_CLIENT_METHODS,
  LocalIronClient,
  serializeError,
  type IronClientMethod,
  type IronEvent,
  type IronProxy,
  type SerializedError,
} from '@iron-proxy/core';
import {
  channels,
  DEFAULT_CHANNEL_PREFIX,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
  type WebContentsLike,
} from './electron-types.js';

/** Wire shape of a failed IPC call. The preload turns it back into an Error. */
export interface IronIpcError {
  __ironError: SerializedError;
}

export function isIronIpcError(v: unknown): v is IronIpcError {
  return typeof v === 'object' && v !== null && '__ironError' in v;
}

export interface InstallIronProxyOptions {
  ipcMain: IpcMainLike;
  iron: IronProxy;
  channelPrefix?: string;
  /** Override the client the dispatcher calls into. Defaults to LocalIronClient(iron). */
  client?: LocalIronClient;
}

export interface IronProxyInstallation {
  channelPrefix: string;
  /** Renderers currently receiving events. */
  subscriberCount(): number;
  dispose(): void;
}

const ALLOWED = new Set<string>(IRON_CLIENT_METHODS);

/**
 * Register one `ipcMain.handle` dispatcher for every IronClient method and
 * forward manager events to renderers that asked for them.
 *
 * Errors never cross the bridge as thrown exceptions (Electron would strip the
 * code); they are returned as `{ __ironError }` and rethrown by the preload.
 */
export function installIronProxy(opts: InstallIronProxyOptions): IronProxyInstallation {
  const prefix = opts.channelPrefix ?? DEFAULT_CHANNEL_PREFIX;
  const ch = channels(prefix);
  const client = opts.client ?? new LocalIronClient(opts.iron);
  const subscribers = new Map<number, WebContentsLike>();

  opts.ipcMain.handle(ch.call, async (_event, method, ...args) => {
    if (typeof method !== 'string' || !ALLOWED.has(method)) {
      return {
        __ironError: {
          name: 'IronProxyError',
          code: 'UNSUPPORTED',
          message: `Unknown iron-proxy method "${String(method)}".`,
          retryable: false,
        },
      } satisfies IronIpcError;
    }
    try {
      const fn = client[method as IronClientMethod] as (...a: unknown[]) => Promise<unknown>;
      const result = await fn.apply(client, args);
      return result === undefined ? null : result;
    } catch (err) {
      return { __ironError: serializeError(err) } satisfies IronIpcError;
    }
  });

  const onSubscribe = (event: IpcMainInvokeEventLike) => {
    const sender = event.sender;
    if (subscribers.has(sender.id)) return;
    subscribers.set(sender.id, sender);
    sender.once('destroyed', () => subscribers.delete(sender.id));
  };
  const onUnsubscribe = (event: IpcMainInvokeEventLike) => {
    subscribers.delete(event.sender.id);
  };
  opts.ipcMain.on(ch.subscribe, onSubscribe);
  opts.ipcMain.on(ch.unsubscribe, onUnsubscribe);

  const offEvents = opts.iron.events.onAny((event: IronEvent) => {
    for (const [id, wc] of subscribers) {
      if (wc.isDestroyed()) {
        subscribers.delete(id);
        continue;
      }
      try {
        wc.send(ch.event, event);
      } catch {
        subscribers.delete(id);
      }
    }
  });

  return {
    channelPrefix: prefix,
    subscriberCount: () => subscribers.size,
    dispose() {
      offEvents();
      opts.ipcMain.removeHandler(ch.call);
      opts.ipcMain.removeListener(ch.subscribe, onSubscribe);
      opts.ipcMain.removeListener(ch.unsubscribe, onUnsubscribe);
      subscribers.clear();
    },
  };
}
