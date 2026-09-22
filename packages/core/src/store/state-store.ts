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

/** `<dataDir>/state.json`, debounced so a busy stream does not hammer the disk. */
export class FileStateStore implements StateStore {
  readonly path: string;
  private cache: Record<string, ProfileState> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private readonly debounceMs: number;

  constructor(dataDir: string, opts: { debounceMs?: number } = {}) {
    this.path = join(dataDir, 'state.json');
    this.debounceMs = opts.debounceMs ?? 150;
  }

  private async load(): Promise<Record<string, ProfileState>> {
    if (this.cache) return this.cache;
    const file = await readJsonFile<StateFile>(this.path, { version: 1, states: {} });
    this.cache = file.states;
    return this.cache;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = writeJsonFileAtomic(this.path, {
        version: 1,
        states: this.cache ?? {},
      } satisfies StateFile).catch(() => {});
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Force any debounced write to disk now. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await writeJsonFileAtomic(this.path, {
        version: 1,
        states: this.cache ?? {},
      } satisfies StateFile);
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
    (await this.load())[state.profileId] = structuredClone(state);
    this.schedule();
  }
  async delete(id: string): Promise<void> {
    delete (await this.load())[id];
    this.schedule();
  }
}
