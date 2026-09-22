import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { IronProxyError } from '../errors.js';
import { readJsonFile, writeJsonFileAtomic } from '../util.js';

/** Secret storage. Keys are opaque references, values are UTF-8 strings. */
export interface Vault {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
  has(ref: string): Promise<boolean>;
}

export class MemoryVault implements Vault {
  private readonly map = new Map<string, string>();
  async get(ref: string) {
    return this.map.get(ref);
  }
  async set(ref: string, secret: string) {
    this.map.set(ref, secret);
  }
  async delete(ref: string) {
    this.map.delete(ref);
  }
  async has(ref: string) {
    return this.map.has(ref);
  }
}

/**
 * Protects the vault's master key at rest. The default stores the raw key in a
 * 0600 file, which is what "click and continue" needs on a single-user machine.
 * `@iron-proxy/electron` supplies one that wraps the key with `safeStorage`
 * (DPAPI / Keychain / libsecret) so the key file is useless off the machine.
 */
export interface KeyProtector {
  protect(rawKey: Buffer): Promise<Buffer>;
  unprotect(stored: Buffer): Promise<Buffer>;
  /** Short label written into the key file header for diagnostics. */
  readonly label: string;
}

export const plainKeyProtector: KeyProtector = {
  label: 'plain',
  protect: async (k) => k,
  unprotect: async (k) => k,
};

interface VaultFile {
  version: 1;
  /** ref -> base64(iv | ciphertext | tag) */
  entries: Record<string, string>;
}

interface KeyFile {
  version: 1;
  protector: string;
  key: string; // base64 of protected key
}

/**
 * AES-256-GCM vault in `<dataDir>/vault.json`, master key in `<dataDir>/vault.key`.
 * Each entry gets its own IV; the ref is bound as AAD so entries cannot be
 * swapped between references.
 */
export class FileVault implements Vault {
  readonly vaultPath: string;
  readonly keyPath: string;
  private key: Buffer | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly protector: KeyProtector = plainKeyProtector,
  ) {
    this.vaultPath = join(dataDir, 'vault.json');
    this.keyPath = join(dataDir, 'vault.key');
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key) return this.key;
    let file: KeyFile | undefined;
    try {
      file = JSON.parse(await readFile(this.keyPath, 'utf8')) as KeyFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new IronProxyError(
          'VAULT_ERROR',
          `Cannot read vault key: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }
    if (file) {
      if (file.protector !== this.protector.label) {
        throw new IronProxyError(
          'VAULT_ERROR',
          `Vault key was protected with "${file.protector}" but this process uses "${this.protector.label}".`,
        );
      }
      this.key = await this.protector.unprotect(Buffer.from(file.key, 'base64'));
      return this.key;
    }
    const raw = randomBytes(32);
    const protectedKey = await this.protector.protect(raw);
    await mkdir(dirname(this.keyPath), { recursive: true });
    const out: KeyFile = {
      version: 1,
      protector: this.protector.label,
      key: protectedKey.toString('base64'),
    };
    await writeFile(this.keyPath, JSON.stringify(out), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    }).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EEXIST') return; // another process won the race; reload below
      throw err;
    });
    try {
      await chmod(this.keyPath, 0o600);
    } catch {
      /* Windows */
    }
    this.key = undefined;
    const reloaded = JSON.parse(await readFile(this.keyPath, 'utf8')) as KeyFile;
    this.key = await this.protector.unprotect(Buffer.from(reloaded.key, 'base64'));
    return this.key;
  }

  private async load(): Promise<VaultFile> {
    return readJsonFile<VaultFile>(this.vaultPath, { version: 1, entries: {} });
  }

  private encrypt(key: Buffer, ref: string, plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64');
  }

  private decrypt(key: Buffer, ref: string, packed: string): string {
    const buf = Buffer.from(packed, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const ct = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(ref, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  get(ref: string): Promise<string | undefined> {
    return this.serial(async () => {
      const file = await this.load();
      const packed = file.entries[ref];
      if (!packed) return undefined;
      const key = await this.loadKey();
      try {
        return this.decrypt(key, ref, packed);
      } catch (err) {
        throw new IronProxyError(
          'VAULT_ERROR',
          `Cannot decrypt secret "${ref}". Key file changed?`,
          { cause: err },
        );
      }
    });
  }

  set(ref: string, secret: string): Promise<void> {
    return this.serial(async () => {
      const key = await this.loadKey();
      const file = await this.load();
      file.entries[ref] = this.encrypt(key, ref, secret);
      await writeJsonFileAtomic(this.vaultPath, file);
    });
  }

  delete(ref: string): Promise<void> {
    return this.serial(async () => {
      const file = await this.load();
      if (ref in file.entries) {
        delete file.entries[ref];
        await writeJsonFileAtomic(this.vaultPath, file);
      }
    });
  }

  has(ref: string): Promise<boolean> {
    return this.serial(async () => ref in (await this.load()).entries);
  }
}
