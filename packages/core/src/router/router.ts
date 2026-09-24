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
  /** Set when a nearly-full account ahead of this one was deferred (pre-emption). */
  preempted?: QuotaSignal;
}

/** Usage with no reset time is ignored once it is this old. */
export const USAGE_STALE_MS = 10 * 60_000;

/** The user turn appended to a continuation request on every lane except Anthropic's API. */
export const CONTINUE_INSTRUCTION =
  'Continue exactly where you stopped. Do not repeat any text you already wrote.';

/**
 * Whether a usage snapshot still describes the current window: its `resetAt` is
 * ahead of `now`, or (without one) it was observed in the last ten minutes.
 */
export function isUsageFresh(usage: UsageSnapshot, now: number): boolean {
  if (usage.resetAt !== undefined) {
    const reset = Date.parse(usage.resetAt);
    return !Number.isNaN(reset) && reset > now;
  }
  const seen = Date.parse(usage.observedAt);
  return !Number.isNaN(seen) && now - seen <= USAGE_STALE_MS;
}

/**
 * Whether an account is 'hot': its fresh usage says at least `threshold` of the
 * window is used and the window's reset is still ahead. A threshold of 1 or more
 * means pre-emption is off.
 */
export function isUsageHot(
  usage: UsageSnapshot | undefined,
  threshold: number,
  now: number,
): boolean {
  if (!usage || !(threshold < 1)) return false;
  if (usage.resetAt === undefined || !isUsageFresh(usage, now)) return false;
  return usage.utilisation !== undefined && usage.utilisation >= threshold;
}

/**
 * The request that continues a cut-off answer: the original request plus the
 * partial text as an assistant turn. When the caller's request already ends with
 * an assistant turn (a prefill), the partial text is added to that turn instead,
 * so there are never two assistant turns in a row. The Anthropic API lane
 * continues an assistant prefill natively (trailing whitespace trimmed, which it
 * requires); every other lane also gets a user turn asking it to carry on.
 */
export function continuationRequest(
  req: UnifiedRequest,
  partial: string,
  profile: Pick<Profile, 'provider' | 'lane'>,
): UnifiedRequest {
  const native = profile.provider === 'anthropic' && profile.lane === 'api-key';
  const text = native ? partial.trimEnd() : partial;
  const messages = [...req.messages];
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant')
    messages[messages.length - 1] = {
      ...last,
      content: [...last.content, { type: 'text', text }],
    };
  else messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
  if (!native)
    messages.push({ role: 'user', content: [{ type: 'text', text: CONTINUE_INSTRUCTION }] });
  return { ...req, messages };
}

function streamInterrupted(profile: Profile, signal: QuotaSignal): IronProxyError {
  return new IronProxyError(
    'STREAM_INTERRUPTED',
    `Account "${profile.title}" hit a limit mid-stream. Resend to continue on the next account.`,
    {
      retryable: true,
      details: { profileId: profile.id, signal },
      hint: 'Resend; the next account will take it.',
    },
  );
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Why a request skipped a nearly-full account. Carries no secrets and no account names. */
function preemptSignal(usage: UsageSnapshot): QuotaSignal {
  const pct = Math.round((usage.utilisation ?? 1) * 100);
  return {
    kind: 'rate-limit',
    source: 'usage',
    message: `Switched early: ${pct}% of the window used${usage.resetAt ? `, resets ${clockTime(usage.resetAt)}` : ''}`,
    ...(usage.resetAt ? { resetAt: usage.resetAt } : {}),
  };
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
  /** Usage writes in flight per profile, so a later state write never overwrites them. */
  private readonly usageWrites = new Map<string, Promise<void>>();
  private readonly usageListeners = new Set<(profileId: string, usage: UsageSnapshot) => void>();

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
        await this.markServed(profile, provider, attempt.preempted ?? lastSignal);
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
          if (opts.strict) throw new QuotaExceededError(profile.id, signal, provider);
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
    const resume =
      !opts.strict && (opts.resumeInterrupted ?? this.policyFor(provider).resumeInterrupted);
    /** Every text delta the caller has seen, across accounts (the resume prefill). */
    let sentText = '';
    /** Tool calls started but not yet ended: a cut inside one cannot be continued. */
    const openTools = new Set<string>();
    /** Set while an answer cut off mid-stream waits for the next account to continue it. */
    let interrupted: { profile: Profile; signal: QuotaSignal } | undefined;

    for (;;) {
      const attempt = await this.nextAttempt(provider, opts, tried);
      if (!attempt) {
        if (interrupted) {
          // Resume found nobody left: the caller gets today's retryable error.
          const e = streamInterrupted(interrupted.profile, interrupted.signal);
          this.deps.emitter.emit({
            type: 'request.failed',
            requestId,
            provider,
            error: e.toJSON(),
          });
          yield { type: 'error', error: e.toJSON() };
          return;
        }
        const err = await this.exhausted(provider, tried, lastSignal);
        yield { type: 'error', error: serializeError(err) };
        return;
      }
      const { profile, ctx } = attempt;
      tried.push(profile.id);
      const attemptReq = interrupted ? continuationRequest(req, sentText, profile) : req;
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
            for await (const ev of lane.stream(attemptReq, ctx)) {
              const full = (
                ev.type === 'start' ? { ...ev, provider, profileId: profile.id } : ev
              ) as StreamEvent;
              if (full.type === 'start' && interrupted) {
                // The continuation: announce the switch, swallow its second `start`.
                const from = interrupted;
                interrupted = undefined;
                emitted = true;
                yield {
                  type: 'switched',
                  fromProfileId: from.profile.id,
                  toProfileId: profile.id,
                  reason: lastSignal ?? from.signal,
                  resumed: true,
                };
                continue;
              }
              if (full.type === 'start' && previous) {
                yield {
                  type: 'switched',
                  fromProfileId: previous,
                  toProfileId: profile.id,
                  reason: lastSignal!,
                };
              }
              if (full.type === 'usage') usage = full.usage;
              else if (full.type === 'text') sentText += full.delta;
              else if (full.type === 'tool_call_start') openTools.add(full.id);
              else if (full.type === 'tool_call_end') openTools.delete(full.id);
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
        await this.markServed(profile, provider, attempt.preempted ?? lastSignal);
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
            // Nothing from this attempt reached the caller: silent failover. While a
            // resume is pending, the next account continues it instead.
            if (!interrupted) previous = profile.id;
            continue;
          }
          if (emitted && resume && sentText.trim() && openTools.size === 0) {
            interrupted = { profile, signal };
            continue; // continue the answer on the next account of this provider
          }
          const e = emitted
            ? streamInterrupted(profile, signal)
            : new QuotaExceededError(profile.id, signal, provider);
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

  /**
   * Called after every usage snapshot a lane reports has been stored on the
   * profile's state (the manager records utilisation samples from it). Listener
   * errors are swallowed. Returns an unsubscribe function.
   */
  onUsage(listener: (profileId: string, usage: UsageSnapshot) => void): () => void {
    this.usageListeners.add(listener);
    return () => {
      this.usageListeners.delete(listener);
    };
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

  /**
   * Whether a request would try this profile right now. Clears a park whose
   * cooldown has passed first (the auto-return), exactly as every request does.
   * Unauthenticated profiles are skipped unless the caller pinned one.
   */
  async availability(
    profile: Profile,
    opts: Pick<RunOptions, 'profileId'> = {},
    now = this.clock.now(),
  ): Promise<{ usable: boolean; state: ProfileState }> {
    const st = await this.state(profile.id);
    if (st.status === 'parked') {
      if (st.parkedUntil && new Date(st.parkedUntil).getTime() <= now) {
        st.status = 'ready';
        delete st.parkedUntil;
        delete st.parkedReason;
        await this.deps.states.put(st);
        this.deps.emitter.emit({ type: 'profile.unparked', profileId: profile.id });
      } else return { usable: false, state: st };
    }
    if (st.status === 'unauthenticated' && !opts.profileId) return { usable: false, state: st };
    try {
      this.deps.registry.laneFor(profile);
    } catch {
      // provider has no such lane registered (e.g. oauth without an extension)
      return { usable: false, state: st };
    }
    return { usable: true, state: st };
  }

  private async nextAttempt(
    provider: ProviderId,
    opts: RunOptions,
    tried: string[],
  ): Promise<Attempt | undefined> {
    const now = this.clock.now();
    const candidates = await this.candidates(provider, opts);
    if (!candidates.length && !tried.length) throw new NoProfileError(provider);
    const hot = await this.hotProfiles(provider, candidates, opts, now);
    // Hot accounts go last for this request only; if all are hot, the order stands.
    const ordered =
      hot.size && hot.size < candidates.length
        ? [...candidates.filter((p) => !hot.has(p.id)), ...candidates.filter((p) => hot.has(p.id))]
        : candidates;
    for (const profile of ordered) {
      if (tried.includes(profile.id)) continue;
      if (!(await this.availability(profile, opts, now)).usable) continue;
      let preempted: QuotaSignal | undefined;
      if (!hot.has(profile.id)) {
        // Was a usable account ahead of this one deferred only because it is nearly full?
        for (const ahead of candidates.slice(0, candidates.indexOf(profile))) {
          const usage = hot.get(ahead.id);
          if (!usage || tried.includes(ahead.id)) continue;
          if (!(await this.availability(ahead, opts, now)).usable) continue;
          preempted = preemptSignal(usage);
          break;
        }
      }
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
        reportUsage: (usage: UsageSnapshot) => this.reportUsage(profile.id, usage),
      };
      return {
        profile,
        ctx,
        release: () => {
          clearTimeout(timeout);
          opts.signal?.removeEventListener('abort', onOuterAbort);
        },
        ...(preempted ? { preempted } : {}),
      };
    }
    return undefined;
  }

  /**
   * Candidates whose last usage snapshot is nearly full (see isUsageHot), with
   * that snapshot. Empty when the caller pinned a profile or the provider's
   * policy turns pre-emption off.
   */
  private async hotProfiles(
    provider: ProviderId,
    candidates: Profile[],
    opts: RunOptions,
    now: number,
  ): Promise<Map<string, UsageSnapshot>> {
    const hot = new Map<string, UsageSnapshot>();
    const threshold = this.policyFor(provider).preemptAtUtilisation;
    if (opts.profileId || !(threshold < 1)) return hot;
    for (const p of candidates) {
      await this.usageWrites.get(p.id);
      const usage = (await this.state(p.id)).usage;
      if (usage && isUsageHot(usage, threshold, now)) hot.set(p.id, usage);
    }
    return hot;
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
    if (last?.kind === 'auth-expired' && tried.length === 1) {
      const p = await this.deps.profiles.get(tried[0]!);
      return new AuthRequiredError(tried[0]!, last.message, {
        ...(p ? { title: p.title, lane: p.lane } : {}),
      });
    }
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
        hint: 'Pass the provider (x-iron-provider header, --provider, or RunOptions.provider) or a model name starting with claude, gpt, gemini or grok.',
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* State                                                            */
  /* ---------------------------------------------------------------- */

  async state(profileId: string): Promise<ProfileState> {
    return (await this.deps.states.get(profileId)) ?? { profileId, status: 'unknown', served: 0 };
  }

  /**
   * Resolves once every usage snapshot reported so far has been stored and its
   * onUsage listeners have run, including writes queued while waiting.
   */
  async settleUsage(): Promise<void> {
    while (this.usageWrites.size) await Promise.all([...this.usageWrites.values()]);
  }

  /** Queue a usage write behind any earlier one for the same profile. */
  private reportUsage(profileId: string, usage: UsageSnapshot): void {
    const prev = this.usageWrites.get(profileId) ?? Promise.resolve();
    const next = prev.then(() => this.recordUsage(profileId, usage)).catch(() => {});
    this.usageWrites.set(profileId, next);
    void next.then(() => {
      if (this.usageWrites.get(profileId) === next) this.usageWrites.delete(profileId);
    });
  }

  private async recordUsage(profileId: string, usage: UsageSnapshot): Promise<void> {
    const st = await this.state(profileId);
    st.usage = usage;
    await this.deps.states.put(st);
    this.deps.emitter.emit({ type: 'profile.state', state: st });
    for (const l of this.usageListeners) {
      try {
        l(profileId, usage);
      } catch {
        /* a listener never breaks a request */
      }
    }
  }

  private async markServed(
    profile: Profile,
    provider: ProviderId,
    reason?: QuotaSignal,
  ): Promise<void> {
    await this.usageWrites.get(profile.id);
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
        ...(reason ? { reason } : {}),
      });
    }
  }

  async park(profile: Profile, signal: QuotaSignal): Promise<void> {
    const policy = this.policyFor(profile.provider);
    const now = this.clock.now();
    await this.usageWrites.get(profile.id);
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
