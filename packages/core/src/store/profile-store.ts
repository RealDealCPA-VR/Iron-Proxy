import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile } from '../types.js';
import { readJsonFile, writeJsonFileAtomic } from '../util.js';

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
 * through a promise chain so concurrent puts never interleave.
 *
 * The file is shared by every process on the same data directory (the CLI, a
 * running `serve`, the tray app), so the cache is re-read whenever the file on
 * disk is no longer the one this store last read or wrote: an account another
 * process added is seen, and a later write here does not drop it.
 */
export class FileProfileStore implements ProfileStore {
  readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();
  private cache: Map<string, Profile> | undefined;
  /** Identity of the file the cache came from (or was last written to). */
  private seen: string | undefined;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'profiles.json');
  }

  /** Changes on every atomic replace: a rename gives a new inode, and mtime/size move with edits. */
  private async fingerprint(): Promise<string> {
    try {
      const st = await stat(this.path);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  private async load(): Promise<Map<string, Profile>> {
    const fp = await this.fingerprint();
    if (this.cache && fp === this.seen) return this.cache;
    const file = await readJsonFile<ProfilesFile>(this.path, { version: 1, profiles: [] });
    this.cache = new Map(file.profiles.map((p) => [p.id, p]));
    this.seen = fp;
    return this.cache;
  }

  private async flush(): Promise<void> {
    const map = await this.load();
    const file: ProfilesFile = { version: 1, profiles: [...map.values()] };
    await writeJsonFileAtomic(this.path, file);
    this.seen = await this.fingerprint();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
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
      (await this.load()).set(profile.id, structuredClone(profile));
      await this.flush();
    });
  }
  delete(id: string): Promise<void> {
    return this.serial(async () => {
      (await this.load()).delete(id);
      await this.flush();
    });
  }
}
