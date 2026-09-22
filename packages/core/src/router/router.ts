import type {
  FailoverPolicy,
  Profile,
  ProfileState,
  ProviderId,
  QuotaSignal,
  RunOptions,
  StreamEvent,
  UnifiedRequest,
  UnifiedResponse,
  UsageSnapshot,
} from '../types.js';
import { DEFAULT_POLICY } from '../types.js';
import {
  AllProfilesExhaustedError,
  AuthRequiredError,
  IronProxyError,
  NoProfileError,
  ProfileNotFoundError,
  ProviderError,
  QuotaExceededError,
  serializeError,
} from '../errors.js';
import type { IronEmitter } from '../events.js';
import type { AdapterRegistry, FetchLike, AttemptContext } from '../adapters/types.js';
import { LaneQuotaSignal } from '../adapters/types.js';
import type { ProfileStore } from '../store/profile-store.js';
import type { StateStore } from '../store/state-store.js';
import type { Vault } from '../vault/vault.js';
import { inferProvider, newId, sleep, systemClock, type Clock } from '../util.js';

export interface RouterDeps {
  profiles: ProfileStore;
  states: StateStore;
  vault: Vault;
  registry: AdapterRegistry;
  emitter: IronEmitter;
  policy?: Partial<FailoverPolicy>;
  clock?: Clock;
  fetch?: FetchLike;
}

interface Attempt {
  profile: Profile;
  ctx: AttemptContext;
  release(): void;
}

/**
 * Ordered same-provider failover with cooldown and automatic return.
 *
 * Candidates are the provider's enabled profiles sorted by `order`, minus the
 * ones parked until later. A quota signal parks the profile and the next one
 * is tried. Because candidates are re-sorted on every request, the lowest-order
 * profile takes over again as soon as its park expires: that is the auto-return.
 */
export class Router {
  private readonly policy: FailoverPolicy;
  private readonly clock: Clock;
  private readonly fetch: FetchLike;
  private readonly activeByProvider = new Map<ProviderId, string>();

  constructor(private readonly deps: RouterDeps) {
    this.policy = { ...DEFAULT_POLICY, ...(deps.policy ?? {}) };
    this.clock = deps.clock ?? systemClock;
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  policyFor(provider: ProviderId): FailoverPolicy {
    return { ...this.policy, ...(this.policy.providers?.[provider] ?? {}) };
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                       */
  /* ---------------------------------------------------------------- */

  async complete(req: UnifiedRequest, opts: RunOptions = {}): Promise<UnifiedResponse> {
    const provider = await this.resolveProvider(req, opts);
    const requestId = newId('req');
    const tried: string[] = [];
    let lastSignal: QuotaSignal | undefined;

    for (;;) {
      const attempt = await this.nextAttempt(provider, opts, tried);
      if (!attempt) throw await this.exhausted(provider, tried, lastSignal);
      const { profile, ctx } = attempt;
      tried.push(profile.id);
      const startedAt = this.clock.now();
      this.deps.emitter.emit({
        type: 'request.started',
        requestId,
        provider,
        profileId: profile.id,
      });
      try {
        const lane = this.deps.registry.laneFor(profile);
        const res = await this.withOverloadRetry(provider, profile, () => lane.complete(req, ctx));
        await this.markServed(profile, provider);
        const out: UnifiedResponse = { ...res, provider, profileId: profile.id };
        if (!opts.includeRaw) delete out.raw;
        this.deps.emitter.emit({
          type: 'request.finished',
          requestId,
          provider,
          profileId: profile.id,
          durationMs: this.clock.now() - startedAt,
          ...(res.usage ? { usage: res.usage } : {}),
        });
        return out;
      } catch (err) {
        const signal = this.asQuotaSignal(err);
        if (signal) {
          lastSignal = signal;
          await this.park(profile, signal);
          if (opts.strict) throw new QuotaExceededError(profile.id, signal);
          continue;
        }
        this.deps.emitter.emit({
          type: 'request.failed',
          requestId,
          provider,
          error: serializeError(err),
        });
        throw err;
      } finally {
        attempt.release();
      }
    }
  }

  async *stream(req: UnifiedRequest, opts: RunOptions = {}): AsyncGenerator<StreamEvent> {
    const provider = await this.resolveProvider(req, opts);
    const requestId = newId('req');
    const tried: string[] = [];
    let lastSignal: QuotaSignal | undefined;
    let previous: string | undefined;

    for (;;) {
      const attempt = await this.nextAttempt(provider, opts, tried);
      if (!attempt) {
        const err = await this.exhausted(provider, tried, lastSignal);
        yield { type: 'error', error: serializeError(err) };
        return;
      }
      const { profile, ctx } = attempt;
      tried.push(profile.id);
      const startedAt = this.clock.now();
      this.deps.emitter.emit({
        type: 'request.started',
        requestId,
        provider,
        profileId: profile.id,
      });
      let emitted = false;
      let usage: UnifiedResponse['usage'];
      try {
        const lane = this.deps.registry.laneFor(profile);
        let overloads = 0;
        for (;;) {
          try {
            for await (const ev of lane.stream(req, ctx)) {
              const full = (
                ev.type === 'start' ? { ...ev, provider, profileId: profile.id } : ev
              ) as StreamEvent;
              if (full.type === 'start' && previous) {
                yield {
                  type: 'switched',
                  fromProfileId: previous,
                  toProfileId: profile.id,
                  reason: lastSignal!,
                };
              }
              if (full.type === 'usage') usage = full.usage;
              emitted = true;
              yield full;
            }
            break;
          } catch (err) {
            const sig = this.asQuotaSignal(err);
            if (
              sig?.kind === 'overloaded' &&
              !emitted &&
              overloads < this.policyFor(provider).overloadRetries
            ) {
              overloads++;
              await sleep(this.backoff(overloads), ctx.signal);
              continue;
            }
            throw err;
          }
        }
        await this.markServed(profile, provider);
        this.deps.emitter.emit({
          type: 'request.finished',
          requestId,
          provider,
          profileId: profile.id,
          durationMs: this.clock.now() - startedAt,
          ...(usage ? { usage } : {}),
        });
        return;
      } catch (err) {
        const signal = this.asQuotaSignal(err);
        if (signal) {
          lastSignal = signal;
          await this.park(profile, signal);
          if (!emitted && !opts.strict) {
            previous = profile.id;
            continue; // silent failover: nothing reached the caller yet
          }
          const e = emitted
            ? new IronProxyError(
                'STREAM_INTERRUPTED',
                `Account "${profile.title}" hit a limit mid-stream. Resend to continue on the next account.`,
                {
                  retryable: true,
                  details: { profileId: profile.id, signal },
                },
              )
            : new QuotaExceededError(profile.id, signal);
          this.deps.emitter.emit({
            type: 'request.failed',
            requestId,
            provider,
            error: e.toJSON(),
          });
          yield { type: 'error', error: e.toJSON() };
          return;
        }
        if ((err as Error).name === 'AbortError') return;
        this.deps.emitter.emit({
          type: 'request.failed',
          requestId,
          provider,
          error: serializeError(err),
        });
        yield { type: 'error', error: serializeError(err) };
        return;
      } finally {
        attempt.release();
      }
    }
  }

  /** Profile currently serving a provider, if any request has run. */
  activeProfileId(provider: ProviderId): string | undefined {
    return this.activeByProvider.get(provider);
  }

  /** Clear a park early (user pressed "try again"). */
  async unpark(profileId: string): Promise<void> {
    const st = await this.state(profileId);
    if (st.status === 'parked') {
      st.status = 'ready';
      delete st.parkedUntil;
      delete st.parkedReason;
      await this.deps.states.put(st);
      this.deps.emitter.emit({ type: 'profile.unparked', profileId });
      this.deps.emitter.emit({ type: 'profile.state', state: st });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Candidate selection                                              */
  /* ---------------------------------------------------------------- */

  async candidates(provider: ProviderId, opts: RunOptions = {}): Promise<Profile[]> {
    const all = (await this.deps.profiles.list()).filter(
      (p) => p.provider === provider && p.enabled,
    );
    if (opts.profileId) {
      const pinned = all.find((p) => p.id === opts.profileId);
      if (!pinned) throw new ProfileNotFoundError(opts.profileId);
      if (opts.strict) return [pinned];
      return [pinned, ...all.filter((p) => p.id !== pinned.id).sort((a, b) => a.order - b.order)];
    }
    return all.sort((a, b) => a.order - b.order);
  }

  private async nextAttempt(
    provider: ProviderId,
    opts: RunOptions,
    tried: string[],
  ): Promise<Attempt | undefined> {
    const now = this.clock.now();
    const candidates = await this.candidates(provider, opts);
    if (!candidates.length && !tried.length) throw new NoProfileError(provider);
    for (const profile of candidates) {
      if (tried.includes(profile.id)) continue;
      const st = await this.state(profile.id);
      if (st.status === 'parked') {
        if (st.parkedUntil && new Date(st.parkedUntil).getTime() <= now) {
          st.status = 'ready';
          delete st.parkedUntil;
          delete st.parkedReason;
          await this.deps.states.put(st);
          this.deps.emitter.emit({ type: 'profile.unparked', profileId: profile.id });
        } else continue;
      }
      if (st.status === 'unauthenticated' && !opts.profileId) continue;
      let lane;
      try {
        lane = this.deps.registry.laneFor(profile);
      } catch {
        continue; // provider has no such lane registered (e.g. oauth without an extension)
      }
      void lane;
      const controller = new AbortController();
      const timeout = setTimeout(
        () =>
          controller.abort(
            new IronProxyError('TIMEOUT', 'Request timed out.', { retryable: true }),
          ),
        opts.timeoutMs ?? this.policyFor(provider).requestTimeoutMs,
      );
      timeout.unref?.();
      const onOuterAbort = () => controller.abort(opts.signal?.reason);
      opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
      if (opts.signal?.aborted) onOuterAbort();
      const ctx: AttemptContext = {
        profile,
        vault: this.deps.vault,
        fetch: this.fetch,
        signal: controller.signal,
        now: () => this.clock.now(),
        reportUsage: (usage: UsageSnapshot) => void this.recordUsage(profile.id, usage),
      };
      return {
        profile,
        ctx,
        release: () => {
          clearTimeout(timeout);
          opts.signal?.removeEventListener('abort', onOuterAbort);
        },
      };
    }
    return undefined;
  }

  private async exhausted(
    provider: ProviderId,
    tried: string[],
    last: QuotaSignal | undefined,
  ): Promise<IronProxyError> {
    if (!tried.length) return new NoProfileError(provider);
    const states = await this.deps.states.all();
    let earliest: string | undefined;
    for (const id of tried) {
      const until = states[id]?.parkedUntil;
      if (until && (!earliest || until < earliest)) earliest = until;
    }
    if (last?.kind === 'auth-expired' && tried.length === 1)
      return new AuthRequiredError(tried[0]!, last.message);
    this.deps.emitter.emit({
      type: 'provider.exhausted',
      provider,
      ...(earliest ? { earliestResetAt: earliest } : {}),
    });
    return new AllProfilesExhaustedError(provider, earliest, tried);
  }

  private async resolveProvider(req: UnifiedRequest, opts: RunOptions): Promise<ProviderId> {
    if (opts.provider) return opts.provider;
    if (opts.profileId) {
      const p = await this.deps.profiles.get(opts.profileId);
      if (!p) throw new ProfileNotFoundError(opts.profileId);
      return p.provider;
    }
    const inferred = inferProvider(req.model);
    if (inferred) return inferred;
    // One provider configured: use it. Otherwise the caller must say.
    const providers = new Set(
      (await this.deps.profiles.list()).filter((p) => p.enabled).map((p) => p.provider),
    );
    if (providers.size === 1) return [...providers][0]!;
    throw new IronProxyError(
      'INVALID_REQUEST',
      'Cannot infer the provider from the model name. Pass `provider` or a recognisable model.',
      {
        details: { model: req.model, configuredProviders: [...providers] },
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */

  async state(profileId: string): Promise<ProfileState> {
    return (await this.deps.states.get(profileId)) ?? { profileId, status: 'unknown', served: 0 };
  }

  private async recordUsage(profileId: string, usage: UsageSnapshot): Promise<void> {
    const st = await this.state(profileId);
    st.usage = usage;
    await this.deps.states.put(st);
    this.deps.emitter.emit({ type: 'profile.state', state: st });
  }

  private async markServed(profile: Profile, provider: ProviderId): Promise<void> {
    const prev = this.activeByProvider.get(provider);
    this.activeByProvider.set(provider, profile.id);
    const st = await this.state(profile.id);
    st.status = 'active';
    st.served += 1;
    st.lastUsedAt = new Date(this.clock.now()).toISOString();
    delete st.lastError;
    await this.deps.states.put(st);
    this.deps.emitter.emit({ type: 'profile.state', state: st });
    if (prev && prev !== profile.id) {
      const ps = await this.state(prev);
      if (ps.status === 'active') {
        ps.status = 'ready';
        await this.deps.states.put(ps);
        this.deps.emitter.emit({ type: 'profile.state', state: ps });
      }
    }
    if (prev !== profile.id) {
      this.deps.emitter.emit({
        type: 'profile.switched',
        provider,
        ...(prev ? { fromProfileId: prev } : {}),
        toProfileId: profile.id,
      });
    }
  }

  async park(profile: Profile, signal: QuotaSignal): Promise<void> {
    const policy = this.policyFor(profile.provider);
    const now = this.clock.now();
    const st = await this.state(profile.id);
    if (signal.kind === 'auth-expired') {
      st.status = 'unauthenticated';
      delete st.parkedUntil;
      st.parkedReason = signal;
      st.lastError = signal.message ?? 'Authentication expired.';
    } else {
      let ms: number;
      if (signal.resetAt) ms = Math.max(0, new Date(signal.resetAt).getTime() - now);
      else if (signal.retryAfterMs !== undefined) ms = signal.retryAfterMs;
      else
        ms =
          signal.kind === 'billing'
            ? policy.billingCooldownMs
            : signal.kind === 'quota-exhausted'
              ? policy.defaultQuotaCooldownMs
              : signal.kind === 'overloaded'
                ? policy.overloadCooldownMs
                : policy.defaultRateLimitCooldownMs;
      ms = Math.min(Math.max(ms, 1_000), policy.maxCooldownMs);
      st.status = 'parked';
      st.parkedUntil = new Date(now + ms).toISOString();
      st.parkedReason = signal;
      st.lastError = signal.message ?? signal.kind;
    }
    await this.deps.states.put(st);
    this.deps.emitter.emit({
      type: 'profile.parked',
      profileId: profile.id,
      reason: signal,
      ...(st.parkedUntil ? { until: st.parkedUntil } : {}),
    });
    this.deps.emitter.emit({ type: 'profile.state', state: st });
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private asQuotaSignal(err: unknown): QuotaSignal | undefined {
    if (err instanceof LaneQuotaSignal) return err.signal;
    if (err instanceof QuotaExceededError) return err.signal;
    if (err instanceof AuthRequiredError)
      return { kind: 'auth-expired', source: 'status', message: err.message };
    if (
      err instanceof ProviderError &&
      err.status !== undefined &&
      err.status >= 500 &&
      err.status !== 501
    ) {
      return { kind: 'overloaded', source: 'status', message: err.message };
    }
    return undefined;
  }

  private backoff(n: number): number {
    return Math.min(2_000 * 2 ** (n - 1), 10_000);
  }

  private async withOverloadRetry<T>(
    provider: ProviderId,
    profile: Profile,
    fn: () => Promise<T>,
  ): Promise<T> {
    const retries = this.policyFor(provider).overloadRetries;
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        const sig = this.asQuotaSignal(err);
        if (sig?.kind === 'overloaded' && i < retries) {
          await sleep(this.backoff(i + 1));
          continue;
        }
        void profile;
        throw err;
      }
    }
  }
}
