import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileState } from '../types.js';
import { readJsonFile, writeJsonFileAtomic } from '../util.js';

/** Persistence for runtime state (parked-until, usage, counters). Safe to wipe. */
export interface StateStore {
  all(): Promise<Record<string, ProfileState>>;
  get(profileId: string): Promise<ProfileState | undefined>;
  put(state: ProfileState): Promise<void>;
  delete(profileId: string): Promise<void>;
}

export class MemoryStateStore implements StateStore {
  private readonly map = new Map<string, ProfileState>();
  async all(): Promise<Record<string, ProfileState>> {
    return Object.fromEntries([...this.map.entries()].map(([k, v]) => [k, structuredClone(v)]));
  }
  async get(id: string): Promise<ProfileState | undefined> {
    const s = this.map.get(id);
    return s ? structuredClone(s) : undefined;
  }
  async put(state: ProfileState): Promise<void> {
    this.map.set(state.profileId, structuredClone(state));
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

interface StateFile {
  version: 1;
  states: Record<string, ProfileState>;
}

/**
 * `<dataDir>/state.json`, debounced so a busy stream does not hammer the disk.
 *
 * Other processes on the same data directory (a running `serve`, the tray app)
 * write this file too. While this store has no write of its own waiting, it
 * re-reads the file when it changed on disk, so a park recorded elsewhere shows.
 */
export class FileStateStore implements StateStore {
  readonly path: string;
  private cache: Record<string, ProfileState> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private readonly debounceMs: number;
  /** Identity of the file the cache came from (or was last written to). */
  private seen: string | undefined;
  /** Writes scheduled or in flight: the cache is newer than the file. */
  private writes = 0;

  constructor(dataDir: string, opts: { debounceMs?: number } = {}) {
    this.path = join(dataDir, 'state.json');
    this.debounceMs = opts.debounceMs ?? 150;
  }

  private async fingerprint(): Promise<string> {
    try {
      const st = await stat(this.path);
      return `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  private async load(): Promise<Record<string, ProfileState>> {
    if (this.cache && (this.timer || this.writes > 0)) return this.cache;
    const fp = await this.fingerprint();
    if (this.cache && fp === this.seen) return this.cache;
    // Re-check: a put may have scheduled a write while we were statting.
    if (this.cache && (this.timer || this.writes > 0)) return this.cache;
    const file = await readJsonFile<StateFile>(this.path, { version: 1, states: {} });
    if (this.cache && (this.timer || this.writes > 0)) return this.cache;
    this.cache = file.states;
    this.seen = fp;
    return this.cache;
  }

  private async write(): Promise<void> {
    this.writes++;
    try {
      await writeJsonFileAtomic(this.path, {
        version: 1,
        states: this.cache ?? {},
      } satisfies StateFile);
      this.seen = await this.fingerprint();
    } finally {
      this.writes--;
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = this.write().catch(() => {});
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Force any debounced write to disk now. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.write();
    }
    await this.pending;
  }

  async all(): Promise<Record<string, ProfileState>> {
    return structuredClone(await this.load());
  }
  async get(id: string): Promise<ProfileState | undefined> {
    const s = (await this.load())[id];
    return s ? structuredClone(s) : undefined;
  }
  async put(state: ProfileState): Promise<void> {
    // Mutate the current cache, not the object load() returned: a concurrent
    // re-read may have replaced it in between.
    await this.load();
    (this.cache ??= {})[state.profileId] = structuredClone(state);
    this.schedule();
  }
  async delete(id: string): Promise<void> {
    await this.load();
    if (this.cache) delete this.cache[id];
    this.schedule();
  }
}
