import { join } from 'node:path';
import type {
  ProfileUsageHistory,
  UsageParkRecord,
  UsageRequestRecord,
  UsageSampleRecord,
} from '../types.js';
import { readJsonFile, systemClock, writeJsonFileAtomic, type Clock } from '../util.js';
import { fileFingerprint, withFileLock, type FileLockOptions } from './file-lock.js';

/** Records older than this are pruned on every write, from every profile. */
export const USAGE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
/** At most this many records (requests + parks + samples) are kept per profile. */
export const USAGE_MAX_RECORDS = 5_000;

/**
 * Per-profile usage history: finished requests, parks and utilisation samples.
 * Bounded (see USAGE_MAX_AGE_MS / USAGE_MAX_RECORDS) and pruned on write: every
 * write drops records past the age limit from every profile (so an idle profile
 * ages out too) and trims the written profile to the record limit. Holds
 * counts and timestamps only: no prompt text, output, secrets or emails.
 */
export interface UsageStore {
  addRequest(profileId: string, record: UsageRequestRecord): Promise<void>;
  addPark(profileId: string, record: UsageParkRecord): Promise<void>;
  addSample(profileId: string, record: UsageSampleRecord): Promise<void>;
  /** One profile's history, oldest first. Empty lists when nothing was recorded. */
  history(profileId: string): Promise<ProfileUsageHistory>;
  all(): Promise<Record<string, ProfileUsageHistory>>;
  delete(profileId: string): Promise<void>;
  /**
   * Write anything buffered to durable storage. Optional: a store that writes
   * through (or keeps nothing) leaves it out. `IronProxy.close()` calls it after
   * the last usage write has landed.
   */
  flush?(): Promise<void>;
}

export interface UsageStoreOptions {
  /** Used to prune by age on write. Default the system clock. */
  clock?: Clock;
  maxAgeMs?: number;
  maxRecordsPerProfile?: number;
}

const empty = (): ProfileUsageHistory => ({ requests: [], parks: [], samples: [] });

function time(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Drop records older than `maxAgeMs`, then the oldest records (across the three
 * kinds) until at most `maxRecords` remain. Mutates and returns `h`.
 */
export function pruneUsageHistory(
  h: ProfileUsageHistory,
  now: number,
  maxAgeMs: number = USAGE_MAX_AGE_MS,
  maxRecords: number = USAGE_MAX_RECORDS,
): ProfileUsageHistory {
  const cutoff = now - maxAgeMs;
  // Lists are appended in time order, so the expired records are a prefix.
  const fresh = <T extends { at: string }>(list: T[]): T[] => {
    let i = 0;
    while (i < list.length && !(time(list[i]!.at) >= cutoff)) i++;
    return i ? list.slice(i) : list;
  };
  h.requests = fresh(h.requests);
  h.parks = fresh(h.parks);
  h.samples = fresh(h.samples);
  let excess = h.requests.length + h.parks.length + h.samples.length - Math.max(0, maxRecords);
  if (excess > 0) {
    // Each list is oldest first: repeatedly drop the oldest head of the three.
    const lists: Array<Array<{ at: string }>> = [h.requests, h.parks, h.samples];
    const heads = [0, 0, 0];
    while (excess > 0) {
      let pick = -1;
      let oldest = Infinity;
      for (let i = 0; i < lists.length; i++) {
        const rec = lists[i]![heads[i]!];
        if (rec && time(rec.at) < oldest) {
          oldest = time(rec.at);
          pick = i;
        }
      }
      if (pick < 0) break;
      heads[pick]!++;
      excess--;
    }
    h.requests = h.requests.slice(heads[0]);
    h.parks = h.parks.slice(heads[1]);
    h.samples = h.samples.slice(heads[2]);
  }
  return h;
}

type UsageKind = 'requests' | 'parks' | 'samples';

/** One change to the history: a record appended, or a profile's history deleted. */
type UsageOp =
  | { type: 'add'; profileId: string; kind: UsageKind; record: { at: string } }
  | { type: 'delete'; profileId: string };

/** Shared bookkeeping for the memory and file stores. */
abstract class BoundedUsageStore implements UsageStore {
  protected readonly clock: Clock;
  protected readonly maxAgeMs: number;
  protected readonly maxRecords: number;

  constructor(opts: UsageStoreOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxAgeMs = opts.maxAgeMs ?? USAGE_MAX_AGE_MS;
    this.maxRecords = opts.maxRecordsPerProfile ?? USAGE_MAX_RECORDS;
  }

  protected abstract load(): Promise<Record<string, ProfileUsageHistory>>;
  /** `op` was just applied to `map` (what load() returned). */
  protected abstract changed(op: UsageOp, map: Record<string, ProfileUsageHistory>): void;

  /**
   * Apply one change to a history map. An append also prunes: the profile to the
   * age and record limits, and every other profile by age (so idle ones age out).
   */
  protected apply(map: Record<string, ProfileUsageHistory>, op: UsageOp): void {
    if (op.type === 'delete') {
      delete map[op.profileId];
      return;
    }
    const h = (map[op.profileId] ??= empty());
    (h[op.kind] as Array<{ at: string }>).push(op.record);
    const now = this.clock.now();
    pruneUsageHistory(h, now, this.maxAgeMs, this.maxRecords);
    for (const [id, other] of Object.entries(map))
      if (id !== op.profileId) pruneUsageHistory(other, now, this.maxAgeMs, Infinity);
  }

  private async add(profileId: string, kind: UsageKind, record: { at: string }): Promise<void> {
    const map = await this.load();
    const op: UsageOp = { type: 'add', profileId, kind, record: structuredClone(record) };
    this.apply(map, op);
    this.changed(op, map);
  }

  addRequest(profileId: string, record: UsageRequestRecord): Promise<void> {
    return this.add(profileId, 'requests', record);
  }
  addPark(profileId: string, record: UsageParkRecord): Promise<void> {
    return this.add(profileId, 'parks', record);
  }
  addSample(profileId: string, record: UsageSampleRecord): Promise<void> {
    return this.add(profileId, 'samples', record);
  }
  async history(profileId: string): Promise<ProfileUsageHistory> {
    const h = (await this.load())[profileId];
    return h ? structuredClone(h) : empty();
  }
  async all(): Promise<Record<string, ProfileUsageHistory>> {
    return structuredClone(await this.load());
  }
  async delete(profileId: string): Promise<void> {
    const map = await this.load();
    if (!(profileId in map)) return;
    const op: UsageOp = { type: 'delete', profileId };
    this.apply(map, op);
    this.changed(op, map);
  }
}

export class MemoryUsageStore extends BoundedUsageStore {
  private readonly map: Record<string, ProfileUsageHistory> = {};
  protected async load(): Promise<Record<string, ProfileUsageHistory>> {
    return this.map;
  }
  protected changed(): void {}
}

interface UsageFile {
  version: 1;
  profiles: Record<string, ProfileUsageHistory>;
}

/**
 * `<dataDir>/usage.json`: atomic writes (temp file + rename), debounced so a busy
 * stream does not hammer the disk. Safe to delete; only the history is lost.
 *
 * Every process on the data directory records into this one file, so a write
 * never replays this process's whole view over it: under a lock file
 * (`usage.json.lock`) it re-reads the file and applies only the records this
 * process appended (and the histories it deleted) since its last write. A read
 * re-loads the file when it changed on disk, with the unsaved records on top.
 */
export class FileUsageStore extends BoundedUsageStore {
  readonly path: string;
  private cache: Record<string, ProfileUsageHistory> | undefined;
  private loading: Promise<Record<string, ProfileUsageHistory>> | undefined;
  /** Identity of the file the cache came from. */
  private seen: string | undefined;
  /** Changes since the last write, oldest first. */
  private readonly ops: UsageOp[] = [];
  /** Bumped by every write, so a read that started before it cannot replace its result. */
  private gen = 0;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly debounceMs: number;
  private readonly lock: FileLockOptions;

  constructor(
    dataDir: string,
    opts: UsageStoreOptions & { debounceMs?: number; lock?: FileLockOptions } = {},
  ) {
    super(opts);
    this.path = join(dataDir, 'usage.json');
    this.debounceMs = opts.debounceMs ?? 500;
    this.lock = opts.lock ?? {};
  }

  private async readDisk(): Promise<Record<string, ProfileUsageHistory>> {
    const file = await readJsonFile<UsageFile>(this.path, { version: 1, profiles: {} }).catch(
      () => ({ version: 1 as const, profiles: {} }), // a corrupt history is dropped, never fatal
    );
    const profiles: Record<string, ProfileUsageHistory> = {};
    for (const [id, h] of Object.entries(file?.profiles ?? {})) {
      profiles[id] = {
        requests: Array.isArray(h?.requests) ? h.requests : [],
        parks: Array.isArray(h?.parks) ? h.parks : [],
        samples: Array.isArray(h?.samples) ? h.samples : [],
      };
    }
    return profiles;
  }

  protected load(): Promise<Record<string, ProfileUsageHistory>> {
    this.loading ??= (async () => {
      try {
        const fp = await fileFingerprint(this.path);
        if (this.cache && fp === this.seen) return this.cache;
        const gen = this.gen;
        const map = await this.readDisk();
        if (gen !== this.gen && this.cache) return this.cache;
        for (const op of this.ops) this.apply(map, op);
        this.cache = map;
        this.seen = fp;
        return map;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  protected changed(op: UsageOp, map: Record<string, ProfileUsageHistory>): void {
    this.ops.push(op);
    // A re-load may have replaced the map the change was applied to.
    if (this.cache && this.cache !== map) this.apply(this.cache, op);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // A failed write keeps its records: try again after another quiet period.
      this.write().catch(() => this.schedule());
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private write(): Promise<void> {
    const run = async () => {
      const n = this.ops.length;
      if (!n) return;
      const ops = this.ops.slice(0, n);
      await withFileLock(
        this.path,
        async () => {
          const map = await this.readDisk();
          for (const op of ops) this.apply(map, op);
          await writeJsonFileAtomic(this.path, { version: 1, profiles: map } satisfies UsageFile);
          const fp = await fileFingerprint(this.path);
          this.ops.splice(0, n);
          for (const op of this.ops) this.apply(map, op);
          this.cache = map;
          this.seen = fp;
          this.gen++;
        },
        this.lock,
      );
    };
    const next = this.writing.then(run, run);
    this.writing = next.catch(() => {});
    return next;
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
}
