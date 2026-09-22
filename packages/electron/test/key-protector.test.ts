import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileVault } from '@iron-proxy/core';
import { SafeStorageKeyProtector, SAFE_STORAGE_LABEL } from '../src/key-protector.js';
import { createElectronIronProxy } from '../src/main.js';
import type { SafeStorageLike } from '../src/electron-types.js';

function fakeSafeStorage(available = true): SafeStorageLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString: (s) => {
      calls.push('encrypt');
      return Buffer.concat([Buffer.from('DPAPI:'), Buffer.from(s, 'utf8').map((b) => b ^ 0x33)]);
    },
    decryptString: (b) => {
      calls.push('decrypt');
      return Buffer.from(b.subarray(6).map((x) => x ^ 0x33)).toString('utf8');
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-kp-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SafeStorageKeyProtector', () => {
  it('wraps the vault key through safeStorage and round-trips', async () => {
    const ss = fakeSafeStorage(true);
    const kp = new SafeStorageKeyProtector(ss);
    expect(kp.label).toBe(SAFE_STORAGE_LABEL);
    const raw = Buffer.from('0123456789abcdef0123456789abcdef');
    const wrapped = await kp.protect(raw);
    expect(wrapped.equals(raw)).toBe(false);
    expect((await kp.unprotect(wrapped)).equals(raw)).toBe(true);

    const vault = new FileVault(dir, kp);
    await vault.set('k', 'secret');
    const keyFile = JSON.parse(await readFile(join(dir, 'vault.key'), 'utf8')) as {
      protector: string;
      key: string;
    };
    expect(keyFile.protector).toBe(SAFE_STORAGE_LABEL);
    expect(Buffer.from(keyFile.key, 'base64').subarray(0, 6).toString()).toBe('DPAPI:');
    expect(await new FileVault(dir, new SafeStorageKeyProtector(ss)).get('k')).toBe('secret');
    expect(ss.calls).toContain('encrypt');
    expect(ss.calls).toContain('decrypt');
  });

  it('falls back to plain with a warning when OS encryption is unavailable', async () => {
    const warnings: string[] = [];
    const kp = new SafeStorageKeyProtector(fakeSafeStorage(false), {
      warn: (m) => warnings.push(m),
    });
    expect(kp.label).toBe('plain');
    expect(warnings).toHaveLength(1);
    const raw = Buffer.from('abc');
    expect((await kp.protect(raw)).equals(raw)).toBe(true);
    const vault = new FileVault(dir, kp);
    await vault.set('k', 'v');
    // a plain FileVault can read it, because the label recorded the truth
    expect(await new FileVault(dir).get('k')).toBe('v');
  });

  it('treats a throwing isEncryptionAvailable as unavailable', () => {
    const ss = fakeSafeStorage(true);
    ss.isEncryptionAvailable = () => {
      throw new Error('not ready');
    };
    const kp = new SafeStorageKeyProtector(ss, { warn: () => {} });
    expect(kp.label).toBe('plain');
  });
});

describe('createElectronIronProxy', () => {
  it('defaults dataDir under userData and uses the safeStorage vault', async () => {
    const iron = createElectronIronProxy({
      app: { getPath: () => dir },
      safeStorage: fakeSafeStorage(true),
    });
    expect(iron.dataDir).toBe(join(dir, 'iron-proxy'));
    const p = await iron.createProfile({
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'sk-test',
    });
    const keyFile = JSON.parse(await readFile(join(dir, 'iron-proxy', 'vault.key'), 'utf8')) as {
      protector: string;
    };
    expect(keyFile.protector).toBe(SAFE_STORAGE_LABEL);
    expect(await iron.vault.get(p.apiKey!.secretRef)).toBe('sk-test');
    await iron.close();
  });
});
