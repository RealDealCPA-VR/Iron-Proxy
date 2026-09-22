import { join } from 'node:path';
import { FileVault, IronProxy, type IronProxyOptions } from '@iron-proxy/core';
import type { AppLike, SafeStorageLike } from './electron-types.js';
import { SafeStorageKeyProtector, type SafeStorageKeyProtectorOptions } from './key-protector.js';

export interface CreateElectronIronProxyOptions extends Omit<IronProxyOptions, 'keyProtector'> {
  app: AppLike;
  safeStorage: SafeStorageLike;
  /** Forwarded to the SafeStorageKeyProtector. */
  protector?: SafeStorageKeyProtectorOptions;
}

/**
 * An IronProxy whose data lives under the app's userData directory and whose
 * vault key is wrapped with Electron's safeStorage. Call after `app.whenReady()`
 * so the OS keyring is available.
 */
export function createElectronIronProxy(opts: CreateElectronIronProxyOptions): IronProxy {
  const { app, safeStorage, protector, ...rest } = opts;
  const dataDir = rest.dataDir ?? join(app.getPath('userData'), 'iron-proxy');
  const vault =
    rest.vault ?? new FileVault(dataDir, new SafeStorageKeyProtector(safeStorage, protector));
  return new IronProxy({ ...rest, dataDir, vault });
}

export {
  SafeStorageKeyProtector,
  SAFE_STORAGE_LABEL,
  type SafeStorageKeyProtectorOptions,
} from './key-protector.js';
export {
  installIronProxy,
  isIronIpcError,
  type InstallIronProxyOptions,
  type IronProxyInstallation,
  type IronIpcError,
} from './ipc.js';
export {
  loginTerminalCommandString,
  openLoginTerminal,
  relevantEnv,
  shellQuote,
  type OpenLoginTerminalOptions,
  type Platform,
} from './terminal.js';
export {
  channels,
  DEFAULT_CHANNEL_PREFIX,
  type AppLike,
  type ContextBridgeLike,
  type IpcMainInvokeEventLike,
  type IpcMainLike,
  type IpcRendererEventLike,
  type IpcRendererLike,
  type SafeStorageLike,
  type WebContentsLike,
} from './electron-types.js';
