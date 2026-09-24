import { join } from 'node:path';
import type {
  ProfileUsageHistory,
  UsageParkRecord,
  UsageRequestRecord,
  UsageSampleRecord,
} from '../types.js';
import { readJsonFile, systemClock, writeJsonFileAtomic, type Clock } from '../util.js';

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
  protected abstract changed(): void;

  private async add(profileId: string, push: (h: ProfileUsageHistory) => void): Promise<void> {
    const map = await this.load();
    const h = (map[profileId] ??= empty());
    push(h);
    const now = this.clock.now();
    pruneUsageHistory(h, now, this.maxAgeMs, this.maxRecords);
    // Idle profiles age out too: every other profile loses its expired records.
    for (const [id, other] of Object.entries(map))
      if (id !== profileId) pruneUsageHistory(other, now, this.maxAgeMs, Infinity);
    this.changed();
  }

  addRequest(profileId: string, record: UsageRequestRecord): Promise<void> {
    return this.add(profileId, (h) => h.requests.push(structuredClone(record)));
  }
  addPark(profileId: string, record: UsageParkRecord): Promise<void> {
    return this.add(profileId, (h) => h.parks.push(structuredClone(record)));
  }
  addSample(profileId: string, record: UsageSampleRecord): Promise<void> {
    return this.add(profileId, (h) => h.samples.push(structuredClone(record)));
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
    delete map[profileId];
    this.changed();
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
 */
export class FileUsageStore extends BoundedUsageStore {
  readonly path: string;
  private cache: Record<string, ProfileUsageHistory> | undefined;
  private loading: Promise<Record<string, ProfileUsageHistory>> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private readonly debounceMs: number;

  constructor(dataDir: string, opts: UsageStoreOptions & { debounceMs?: number } = {}) {
    super(opts);
    this.path = join(dataDir, 'usage.json');
    this.debounceMs = opts.debounceMs ?? 500;
  }

  protected load(): Promise<Record<string, ProfileUsageHistory>> {
    if (this.cache) return Promise.resolve(this.cache);
    this.loading ??= readJsonFile<UsageFile>(this.path, { version: 1, profiles: {} })
      .catch(() => ({ version: 1 as const, profiles: {} })) // a corrupt history is dropped, never fatal
      .then((file) => {
        const profiles: Record<string, ProfileUsageHistory> = {};
        for (const [id, h] of Object.entries(file?.profiles ?? {})) {
          profiles[id] = {
            requests: Array.isArray(h?.requests) ? h.requests : [],
            parks: Array.isArray(h?.parks) ? h.parks : [],
            samples: Array.isArray(h?.samples) ? h.samples : [],
          };
        }
        this.cache ??= profiles;
        return this.cache;
      });
    return this.loading;
  }

  private snapshot(): UsageFile {
    return { version: 1, profiles: this.cache ?? {} };
  }

  protected changed(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = writeJsonFileAtomic(this.path, this.snapshot()).catch(() => {});
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Force any debounced write to disk now. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.pending;
      await writeJsonFileAtomic(this.path, this.snapshot());
    }
    await this.pending;
  }
}
