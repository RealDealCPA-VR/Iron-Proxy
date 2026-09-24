import { join } from 'node:path';
import type { Profile } from '../types.js';
import { readJsonFile, writeJsonFileAtomic } from '../util.js';
import { fileFingerprint, withFileLock, type FileLockOptions } from './file-lock.js';

/** Persistence for profiles. Implement this to store profiles wherever the host likes. */
export interface ProfileStore {
  list(): Promise<Profile[]>;
  get(id: string): Promise<Profile | undefined>;
  put(profile: Profile): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryProfileStore implements ProfileStore {
  private readonly map = new Map<string, Profile>();
  constructor(initial: Profile[] = []) {
    for (const p of initial) this.map.set(p.id, structuredClone(p));
  }
  async list(): Promise<Profile[]> {
    return [...this.map.values()].map((p) => structuredClone(p));
  }
  async get(id: string): Promise<Profile | undefined> {
    const p = this.map.get(id);
    return p ? structuredClone(p) : undefined;
  }
  async put(profile: Profile): Promise<void> {
    this.map.set(profile.id, structuredClone(profile));
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

interface ProfilesFile {
  version: 1;
  profiles: Profile[];
}

/**
 * JSON file store: `<dataDir>/profiles.json`. Writes are atomic and serialised
 * through a promise chain so concurrent puts in this process never interleave.
 *
 * The file is shared by every process on the same data directory (the CLI, a
 * running `serve`, the tray app), so a write never replays this process's whole
 * cache over the file: under a lock file (`profiles.json.lock`) it re-reads the
 * file, applies only this process's change (the profile put, or the id deleted)
 * and writes the result. A read re-loads the file whenever it changed on disk
 * since this store last read or wrote it, so an account another process added
 * is seen, and one it deleted is not brought back.
 */
export class FileProfileStore implements ProfileStore {
  readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();
  private cache: Map<string, Profile> | undefined;
  /** Identity of the file the cache came from (or was last written to). */
  private seen: string | undefined;
  /** Identity of the file this store last wrote. */
  private lastWritten: string | undefined;
  /** File versions written elsewhere that this store has read. */
  private external = 0;
  /** This process's changes not yet on disk: puts by id, and deleted ids. */
  private readonly dirty = new Map<string, Profile>();
  private readonly deleted = new Set<string>();
  private readonly lock: FileLockOptions;

  constructor(dataDir: string, opts: { lock?: FileLockOptions } = {}) {
    this.path = join(dataDir, 'profiles.json');
    this.lock = opts.lock ?? {};
  }

  private async readDisk(): Promise<Map<string, Profile>> {
    const file = await readJsonFile<ProfilesFile>(this.path, { version: 1, profiles: [] });
    return new Map((file.profiles ?? []).map((p) => [p.id, p]));
  }

  private overlay(map: Map<string, Profile>): Map<string, Profile> {
    for (const id of this.deleted) map.delete(id);
    for (const [id, p] of this.dirty) map.set(id, structuredClone(p));
    return map;
  }

  private async load(): Promise<Map<string, Profile>> {
    const fp = await fileFingerprint(this.path);
    if (this.cache && fp === this.seen) return this.cache;
    this.noteVersion(fp);
    this.cache = this.overlay(await this.readDisk());
    this.seen = fp;
    return this.cache;
  }

  /** Re-read the file under the lock, apply this process's changes, write it back. */
  private async commit(): Promise<void> {
    try {
      await withFileLock(
        this.path,
        async () => {
          this.noteVersion(await fileFingerprint(this.path));
          const merged = this.overlay(await this.readDisk());
          const file: ProfilesFile = { version: 1, profiles: [...merged.values()] };
          await writeJsonFileAtomic(this.path, file);
          this.cache = merged;
          this.seen = this.lastWritten = await fileFingerprint(this.path);
        },
        this.lock,
      );
    } catch (err) {
      this.cache = undefined; // re-read: the change did not land
      throw err;
    } finally {
      this.dirty.clear();
      this.deleted.clear();
    }
  }

  /** Count a version of the file that neither this store wrote nor had read already. */
  private noteVersion(fp: string): void {
    if (fp !== 'missing' && fp !== this.seen && fp !== this.lastWritten) this.external++;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * How many versions of the file written by another process (the CLI, a
   * running `serve`, another app) this store has read so far. A watcher can
   * compare it before and after a reload to tell another process's changes from
   * this process's own writes.
   */
  get externalWrites(): number {
    return this.external;
  }

  list(): Promise<Profile[]> {
    return this.serial(async () =>
      [...(await this.load()).values()].map((p) => structuredClone(p)),
    );
  }
  get(id: string): Promise<Profile | undefined> {
    return this.serial(async () => {
      const p = (await this.load()).get(id);
      return p ? structuredClone(p) : undefined;
    });
  }
  put(profile: Profile): Promise<void> {
    return this.serial(async () => {
      this.deleted.delete(profile.id);
      this.dirty.set(profile.id, structuredClone(profile));
      await this.commit();
    });
  }
  delete(id: string): Promise<void> {
    return this.serial(async () => {
      this.dirty.delete(id);
      this.deleted.add(id);
      await this.commit();
    });
  }
}
