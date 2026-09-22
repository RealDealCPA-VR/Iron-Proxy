import type {
  LoginSession,
  Profile,
  ProviderId,
  QuotaSignal,
  StreamEvent,
  UnifiedRequest,
  UnifiedResponse,
  UsageSnapshot,
} from '../types.js';
import type { Vault } from '../vault/vault.js';

export type FetchLike = typeof fetch;

export interface AttemptContext {
  profile: Profile;
  vault: Vault;
  fetch: FetchLike;
  signal: AbortSignal;
  /** Wall clock, injectable for tests. */
  now(): number;
  /** Adapter-reported usage snapshot for the profile (headers, CLI hints). */
  reportUsage(usage: UsageSnapshot): void;
}

/**
 * Thrown by a lane when the account, not the request, is the problem. The
 * router parks the profile and moves on. Anything else propagates as-is.
 */
export class LaneQuotaSignal extends Error {
  constructor(readonly signal: QuotaSignal) {
    super(signal.message ?? signal.kind);
    this.name = 'LaneQuotaSignal';
  }
}

/** Result of a non-streaming attempt, before the router fills in profile metadata. */
export type LaneResponse = Omit<UnifiedResponse, 'profileId' | 'provider'>;

/**
 * A lane executes a request for one profile. Streams must emit `start` first;
 * a LaneQuotaSignal thrown before `start` lets the router fail over silently.
 */
export interface Lane {
  readonly kind: 'cli' | 'api-key' | 'oauth';
  complete(req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse>;
  stream(
    req: UnifiedRequest,
    ctx: AttemptContext,
  ): AsyncIterable<Omit<StreamEvent, 'profileId'> | StreamEvent>;
  /** Quick authentication check. `unknown` when the lane cannot tell without a request. */
  checkAuth(profile: Profile, vault: Vault): Promise<'ok' | 'unauthenticated' | 'unknown'>;
  /** Start an interactive login for the profile, when the lane supports one. */
  login?(profile: Profile, vault: Vault): LoginSession;
  /** Forget credentials for the profile (CLI logout or vault delete). */
  logout?(profile: Profile, vault: Vault): Promise<void>;
  /** Model ids the account can use, when cheaply knowable. */
  listModels?(profile: Profile, ctx: AttemptContext): Promise<string[]>;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly lanes: Partial<Record<Lane['kind'], Lane>>;
  /** Suggested default model for new profiles. */
  readonly defaultModel: string;
}

export class AdapterRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: ProviderId): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`No adapter registered for provider "${id}".`);
    return a;
  }

  laneFor(profile: Profile): Lane {
    const adapter = this.get(profile.provider);
    const lane = adapter.lanes[profile.lane];
    if (!lane) {
      throw new Error(`Provider "${profile.provider}" has no "${profile.lane}" lane.`);
    }
    return lane;
  }

  /** Register an OAuth (or any) lane implementation for a provider after the fact. */
  addLane(provider: ProviderId, lane: Lane): this {
    const adapter = this.get(provider);
    (adapter.lanes as Record<string, Lane>)[lane.kind] = lane;
    return this;
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
