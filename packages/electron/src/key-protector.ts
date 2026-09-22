import { plainKeyProtector, type KeyProtector } from '@iron-proxy/core';
import type { SafeStorageLike } from './electron-types.js';

export const SAFE_STORAGE_LABEL = 'electron-safeStorage';

export interface SafeStorageKeyProtectorOptions {
  /** Receives one warning line when OS encryption is unavailable. Default: console.warn. */
  warn?: (message: string) => void;
}

/**
 * Wraps the vault master key with Electron's `safeStorage` (DPAPI on Windows,
 * Keychain on macOS, libsecret/kwallet on Linux). The key file on disk is then
 * useless on another machine or user account.
 *
 * When the OS backend is unavailable (headless Linux without a keyring, or
 * before `app.whenReady()`), the protector degrades to the plain behaviour
 * and records the label `plain` so the vault file states the truth.
 */
export class SafeStorageKeyProtector implements KeyProtector {
  readonly label: string;
  private readonly available: boolean;

  constructor(
    private readonly safeStorage: SafeStorageLike,
    opts: SafeStorageKeyProtectorOptions = {},
  ) {
    let available = false;
    try {
      available = safeStorage.isEncryptionAvailable();
    } catch {
      available = false;
    }
    this.available = available;
    this.label = available ? SAFE_STORAGE_LABEL : plainKeyProtector.label;
    if (!available) {
      (opts.warn ?? ((m: string) => console.warn(m)))(
        'iron-proxy: OS encryption (safeStorage) is unavailable; the vault key is stored unwrapped in a 0600 file.',
      );
    }
  }

  async protect(rawKey: Buffer): Promise<Buffer> {
    if (!this.available) return plainKeyProtector.protect(rawKey);
    return this.safeStorage.encryptString(rawKey.toString('base64'));
  }

  async unprotect(stored: Buffer): Promise<Buffer> {
    if (!this.available) return plainKeyProtector.unprotect(stored);
    return Buffer.from(this.safeStorage.decryptString(stored), 'base64');
  }
}
