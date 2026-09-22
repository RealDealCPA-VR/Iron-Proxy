/**
 * Structural subsets of the Electron API that this package touches. Declaring
 * them here (instead of importing `electron`) keeps the main entry importable
 * from plain Node, so tests can pass fakes and hosts can inject the real modules.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface AppLike {
  getPath(name: 'userData' | string): string;
}

export interface WebContentsLike {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface IpcMainInvokeEventLike {
  sender: WebContentsLike;
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
  on(
    channel: string,
    listener: (event: IpcMainInvokeEventLike, ...args: unknown[]) => void,
  ): unknown;
  removeListener(
    channel: string,
    listener: (event: IpcMainInvokeEventLike, ...args: unknown[]) => void,
  ): unknown;
}

export interface IpcRendererEventLike {
  sender?: unknown;
}

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: IpcRendererEventLike, ...args: unknown[]) => void): unknown;
  removeListener(
    channel: string,
    listener: (event: IpcRendererEventLike, ...args: unknown[]) => void,
  ): unknown;
}

export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}

export const DEFAULT_CHANNEL_PREFIX = 'iron-proxy';

export function channels(prefix: string = DEFAULT_CHANNEL_PREFIX) {
  return {
    call: `${prefix}:call`,
    event: `${prefix}:event`,
    subscribe: `${prefix}:subscribe`,
    unsubscribe: `${prefix}:unsubscribe`,
  } as const;
}
