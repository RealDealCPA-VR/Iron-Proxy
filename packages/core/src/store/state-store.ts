import { join } from 'node:path';
import type { ProfileState } from '../types.js';
import { readJsonFile, writeJsonFileAtomic } from '../util.js';
import { fileFingerprint, withFileLock, type FileLockOptions } from './file-lock.js';

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
 * write this file too. So this store keeps its own changes apart (the states it
 * put, and the ids it deleted) and a write, under a lock file
 * (`state.json.lock`), re-reads the file and applies only those changes on top:
 * a park another process recorded is never lost. A read re-loads the file when
 * it changed on disk and lays this store's unsaved changes over it, so its own
 * unsaved writes win for the accounts they touch.
 */
export class FileStateStore implements StateStore {
  readonly path: string;
  /** The file as last read or written. */
  private base: Record<string, ProfileState> = {};
  private loaded = false;
  /** Identity of the file `base` came from. */
  private seen: string | undefined;
  /** Identity of the file this store last wrote. */
  private lastWritten: string | undefined;
  /** File versions written elsewhere that this store has read. */
  private external = 0;
  /** Bumped whenever `base` is replaced, so a slower, older read cannot overwrite a newer one. */
  private gen = 0;
  /** Unsaved puts by id, and unsaved deletes (id -> sequence number). */
  private readonly dirty = new Map<string, ProfileState>();
  private readonly deleted = new Map<string, number>();
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly lock: FileLockOptions;

  constructor(dataDir: string, opts: { debounceMs?: number; lock?: FileLockOptions } = {}) {
    this.path = join(dataDir, 'state.json');
    this.debounceMs = opts.debounceMs ?? 150;
    this.lock = opts.lock ?? {};
  }

  private async readDisk(): Promise<Record<string, ProfileState>> {
    const file = await readJsonFile<StateFile>(this.path, { version: 1, states: {} });
    return { ...(file.states ?? {}) };
  }

  private async load(): Promise<void> {
    const fp = await fileFingerprint(this.path);
    if (this.loaded && fp === this.seen) return;
    const gen = this.gen;
    const states = await this.readDisk();
    if (gen !== this.gen) return; // a newer read or write landed meanwhile
    this.noteVersion(fp);
    this.base = states;
    this.seen = fp;
    this.loaded = true;
    this.gen++;
  }

  /** Count a version of the file that neither this store wrote nor had read already. */
  private noteVersion(fp: string): void {
    if (fp !== 'missing' && fp !== this.seen && fp !== this.lastWritten) this.external++;
  }

  private view(): Record<string, ProfileState> {
    const out = { ...this.base };
    for (const id of this.deleted.keys()) delete out[id];
    for (const [id, st] of this.dirty) out[id] = st;
    return out;
  }

  private write(): Promise<void> {
    const run = async () => {
      if (!this.dirty.size && !this.deleted.size) return;
      const puts = new Map(this.dirty);
      const dels = new Map(this.deleted);
      await withFileLock(
        this.path,
        async () => {
          this.noteVersion(await fileFingerprint(this.path));
          const states = await this.readDisk();
          for (const id of dels.keys()) delete states[id];
          for (const [id, st] of puts) states[id] = st;
          await writeJsonFileAtomic(this.path, { version: 1, states } satisfies StateFile);
          const fp = await fileFingerprint(this.path);
          this.base = states;
          this.seen = this.lastWritten = fp;
          this.loaded = true;
          this.gen++;
          // Keep only what changed while this write was in flight.
          for (const [id, st] of puts) if (this.dirty.get(id) === st) this.dirty.delete(id);
          for (const [id, n] of dels) if (this.deleted.get(id) === n) this.deleted.delete(id);
        },
        this.lock,
      );
    };
    const next = this.writing.then(run, run);
    this.writing = next.catch(() => {});
    return next;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // A failed write keeps its changes: try again after another quiet period.
      this.write().catch(() => this.schedule());
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Force any debounced write to disk now. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.writing;
    await this.write();
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

  async all(): Promise<Record<string, ProfileState>> {
    await this.load();
    return structuredClone(this.view());
  }
  async get(id: string): Promise<ProfileState | undefined> {
    await this.load();
    if (this.deleted.has(id) && !this.dirty.has(id)) return undefined;
    const s = this.dirty.get(id) ?? this.base[id];
    return s ? structuredClone(s) : undefined;
  }
  async put(state: ProfileState): Promise<void> {
    this.deleted.delete(state.profileId);
    this.dirty.set(state.profileId, structuredClone(state));
    this.schedule();
  }
  async delete(id: string): Promise<void> {
    this.dirty.delete(id);
    this.deleted.set(id, ++this.seq);
    this.schedule();
  }
}
