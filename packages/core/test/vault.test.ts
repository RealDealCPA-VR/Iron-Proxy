import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileVault, MemoryVault, type KeyProtector } from '../src/vault/vault.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-vault-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('MemoryVault', () => {
  it('round-trips', async () => {
    const v = new MemoryVault();
    await v.set('a', 'secret');
    expect(await v.get('a')).toBe('secret');
    expect(await v.has('a')).toBe(true);
    await v.delete('a');
    expect(await v.get('a')).toBeUndefined();
  });
});

describe('FileVault', () => {
  it('encrypts at rest and round-trips across instances', async () => {
    const v1 = new FileVault(dir);
    await v1.set('apikey:1', 'sk-live-supersecret');
    const raw = await readFile(join(dir, 'vault.json'), 'utf8');
    expect(raw).not.toContain('supersecret');
    const v2 = new FileVault(dir);
    expect(await v2.get('apikey:1')).toBe('sk-live-supersecret');
    expect(await v2.has('nope')).toBe(false);
    await v2.delete('apikey:1');
    expect(await new FileVault(dir).get('apikey:1')).toBeUndefined();
  });

  it('binds the ciphertext to its reference (AAD)', async () => {
    const v = new FileVault(dir);
    await v.set('a', 'one');
    await v.set('b', 'two');
    const file = JSON.parse(await readFile(join(dir, 'vault.json'), 'utf8')) as {
      entries: Record<string, string>;
    };
    [file.entries.a, file.entries.b] = [file.entries.b!, file.entries.a!];
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'vault.json'), JSON.stringify(file));
    await expect(new FileVault(dir).get('a')).rejects.toThrow(/Cannot decrypt/);
  });

  it('uses the key protector and refuses a mismatched one', async () => {
    const xor: KeyProtector = {
      label: 'xor-test',
      protect: async (k) => Buffer.from(k.map((b) => b ^ 0x5a)),
      unprotect: async (k) => Buffer.from(k.map((b) => b ^ 0x5a)),
    };
    const v = new FileVault(dir, xor);
    await v.set('x', 'y');
    expect(await new FileVault(dir, xor).get('x')).toBe('y');
    await expect(new FileVault(dir).get('x')).rejects.toThrow(/protected with "xor-test"/);
  });

  it('serialises concurrent writes', async () => {
    const v = new FileVault(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => v.set(`k${i}`, `v${i}`)));
    for (let i = 0; i < 20; i++) expect(await v.get(`k${i}`)).toBe(`v${i}`);
  });
});
