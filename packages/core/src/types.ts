/**
 * Public domain model for Iron-Proxy.
 *
 * Everything a host application touches is declared here. Adapters, stores and
 * the router are implementation details behind these shapes.
 */

/** Providers with first-class adapters. Anything else goes through `openai-compatible`. */
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai' | 'openai-compatible';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'openai-compatible',
] as const;

/**
 * How a profile authenticates.
 *
 * - `cli`     the account is a logged-in official vendor CLI living in its own
 *             isolated home directory. Requests run through that CLI. No token is
 *             ever read out of the CLI's files.
 * - `api-key` a raw API key (or bearer token) stored in the vault, used over HTTPS.
 * - `oauth`   an extension point. Iron-Proxy ships the interface, not an
 *             implementation. See docs/PROVIDERS.md.
 */
export type LaneKind = 'cli' | 'api-key' | 'oauth';

export interface CliLaneConfig {
  /** Absolute path of the isolated home directory for this account. */
  home: string;
  /** Override the executable name or path. Defaults to the vendor CLI name. */
  binary?: string;
  /** Extra environment variables passed to every spawn. */
  env?: Record<string, string>;
  /**
   * True when `home` is the vendor CLI's own default home (an existing login the
   * user adopted) rather than a directory Iron-Proxy created. Iron-Proxy never
   * deletes or prepares an adopted home, and logging out signs the user's own CLI out.
   */
  adopted?: boolean;
}

export interface ApiKeyLaneConfig {
  /** Vault reference holding the key. Never the key itself. */
  secretRef: string;
  /** Base URL override. Required for `openai-compatible`, optional elsewhere. */
  baseUrl?: string;
  /** Extra headers sent on every request (for gateways that need them). */
  headers?: Record<string, string>;
}

export interface OAuthLaneConfig {
  /** Vault reference holding whatever the extension stores. */
  secretRef: string;
  /** Name of the registered OAuth extension that owns this profile. */
  extension: string;
}

/** A titled account of one provider, in one lane. Persisted by the ProfileStore. */
export interface Profile {
  id: string;
  /** User-facing title, e.g. "Work Claude Max" or "Personal ChatGPT Plus". */
  title: string;
  provider: ProviderId;
  lane: LaneKind;
  /** Failover priority within the provider. Lower runs first. */
  order: number;
  enabled: boolean;
  /** Default model when the request names none. */
  defaultModel?: string;
  cli?: CliLaneConfig;
  apiKey?: ApiKeyLaneConfig;
  oauth?: OAuthLaneConfig;
  createdAt: string;
  updatedAt: string;
}

export type ProfileInput = Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'order' | 'enabled'> &
  Partial<Pick<Profile, 'order' | 'enabled'>>;

export type ProfilePatch = Partial<
  Pick<Profile, 'title' | 'order' | 'enabled' | 'defaultModel' | 'cli' | 'apiKey' | 'oauth'>
>;

/** Why an account was parked. Produced by quota detectors, consumed by the router. */
export type QuotaSignalKind =
  | 'rate-limit' // short window exhausted, retry after reset
  | 'quota-exhausted' // subscription / plan window used up
  | 'billing' // no credit, payment required
  | 'auth-expired' // token invalid, needs re-login
  | 'overloaded'; // provider capacity, not the account's fault

export interface QuotaSignal {
  kind: QuotaSignalKind;
  /** When the account may be tried again, ISO 8601. */
  resetAt?: string;
  /** Alternative to resetAt when only a relative delay is known. */
  retryAfterMs?: number;
  /**
   * Where the signal was read from. `usage` means no limit was hit: the router
   * switched early because the account's last usage snapshot was nearly full
   * (see FailoverPolicy.preemptAtUtilisation).
   */
  source: 'status' | 'header' | 'body' | 'cli-output' | 'usage';
  /** Short human-readable excerpt, safe to show in UI. Never contains secrets. */
  message?: string | undefined;
}

export interface UsageSnapshot {
  /** Remaining requests in the current window, when the provider says. */
  requestsRemaining?: number;
  requestsLimit?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  /** When the current window resets, ISO 8601. */
  resetAt?: string;
  /** 0..1 utilisation estimate when derivable, else undefined. */
  utilisation?: number;
  observedAt: string;
}

export type ProfileStatus =
  | 'ready' // authenticated, not parked
  | 'active' // the profile that served the most recent request for its provider
  | 'parked' // exhausted or errored, waiting for parkedUntil
  | 'unauthenticated' // needs login
  | 'disabled' // user switched it off
  | 'unknown'; // never checked

/** Runtime state, persisted separately from the profile so it can be reset freely. */
export interface ProfileState {
  profileId: string;
  status: ProfileStatus;
  parkedUntil?: string;
  parkedReason?: QuotaSignal;
  usage?: UsageSnapshot;
  lastUsedAt?: string;
  lastError?: string;
  /** Total requests served since the state was created. */
  served: number;
}

/* ------------------------------------------------------------------ */
/* Unified request / response                                          */
/* ------------------------------------------------------------------ */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string } // base64
  | { type: 'image_url'; url: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

export interface Message {
  role: Role;
  content: ContentPart[];
  /** Optional participant name (OpenAI `name`). */
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface UnifiedRequest {
  /** Model name. Provider is inferred from it when `provider` is not given. */
  model?: string;
  system?: string;
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  /** Provider-specific passthrough. Adapters merge what they understand. */
  extra?: Record<string, unknown>;
  /** Free-form metadata that the router echoes back in events. */
  metadata?: Record<string, string>;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface UnifiedResponse {
  id: string;
  model: string;
  provider: ProviderId;
  profileId: string;
  message: Message;
  finishReason: FinishReason;
  usage?: Usage;
  /** Raw provider response, when the caller asked for it. */
  raw?: unknown;
}

export type StreamEvent =
  | { type: 'start'; id: string; model: string; provider: ProviderId; profileId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; finishReason: FinishReason }
  | {
      type: 'switched';
      fromProfileId: string;
      toProfileId: string;
      reason: QuotaSignal;
      /**
       * True when the answer is being continued on the new account after the old
       * one hit a limit mid-stream (RunOptions.resumeInterrupted). The text events
       * that follow carry on from where the earlier text stopped.
       */
      resumed?: true;
    }
  | { type: 'error'; error: SerializedError };

export interface SerializedError {
  name: string;
  message: string;
  code: string;
  /** True when the caller may retry the same request. */
  retryable: boolean;
  details?: Record<string, unknown>;
  /** Short imperative sentence telling the user what to do next. Never contains secrets or emails. */
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* Routing options                                                     */
/* ------------------------------------------------------------------ */

export interface RunOptions {
  /** Force a provider. Otherwise inferred from the model name. */
  provider?: ProviderId;
  /** Pin one profile. Failover still happens within the provider unless `strict`. */
  profileId?: string;
  /** With `profileId`, never switch to another profile. */
  strict?: boolean;
  /** Abort the whole run, including any failover attempt. */
  signal?: AbortSignal;
  /** Attach the provider's raw response to the result. */
  includeRaw?: boolean;
  /** Per-attempt timeout in ms. Defaults to policy.requestTimeoutMs. */
  timeoutMs?: number;
  /**
   * Streaming only: when an account hits a limit after text has flowed (and no
   * tool call is open), continue the answer on the next account of the same
   * provider instead of ending with STREAM_INTERRUPTED. Overrides
   * policy.resumeInterrupted for this request. See docs/FAILOVER.md.
   */
  resumeInterrupted?: boolean;
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

export type LoginEvent =
  | { type: 'started'; profileId: string; method: string }
  | { type: 'url'; profileId: string; url: string }
  | { type: 'code'; profileId: string; code: string }
  | { type: 'output'; profileId: string; line: string }
  | { type: 'completed'; profileId: string }
  | { type: 'failed'; profileId: string; message: string }
  | { type: 'cancelled'; profileId: string };

export interface LoginSession {
  profileId: string;
  /** Resolves when the login finishes, rejects when it fails. */
  done: Promise<void>;
  /** Cancel an in-flight login. */
  cancel(): void;
  /** Subscribe to progress. Returns an unsubscribe function. */
  on(listener: (event: LoginEvent) => void): () => void;
}

/* ------------------------------------------------------------------ */
/* Events emitted by the manager                                       */
/* ------------------------------------------------------------------ */

export type IronEvent =
  | { type: 'profile.created'; profile: Profile }
  | { type: 'profile.updated'; profile: Profile }
  | { type: 'profile.deleted'; profileId: string }
  | { type: 'profile.state'; state: ProfileState }
  | { type: 'profile.parked'; profileId: string; reason: QuotaSignal; until?: string }
  | { type: 'profile.unparked'; profileId: string }
  | {
      type: 'profile.switched';
      provider: ProviderId;
      fromProfileId?: string;
      toProfileId: string;
      reason?: QuotaSignal;
    }
  | { type: 'provider.exhausted'; provider: ProviderId; earliestResetAt?: string }
  | { type: 'request.started'; requestId: string; provider: ProviderId; profileId: string }
  | {
      type: 'request.finished';
      requestId: string;
      provider: ProviderId;
      profileId: string;
      durationMs: number;
      usage?: Usage;
    }
  | { type: 'request.failed'; requestId: string; provider: ProviderId; error: SerializedError }
  | { type: 'login'; event: LoginEvent };

export type IronEventType = IronEvent['type'];

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

export interface FailoverPolicy {
  /** Cooldown used when a rate-limit signal carries no reset time. */
  defaultRateLimitCooldownMs: number;
  /** Cooldown used when a quota-exhausted signal carries no reset time. */
  defaultQuotaCooldownMs: number;
  /** Cooldown for billing problems. Long, because nothing resets by itself. */
  billingCooldownMs: number;
  /** Cooldown for overload (5xx / 529). Short, retried on the same account first. */
  overloadCooldownMs: number;
  /** How many times an overloaded account is retried before moving on. */
  overloadRetries: number;
  /** Upper bound applied to any provider-supplied reset time. */
  maxCooldownMs: number;
  /** Per-attempt timeout. */
  requestTimeoutMs: number;
  /** When true the router returns to the lowest-order ready profile automatically. */
  autoReturn: boolean;
  /**
   * Switch before the wall: an account whose last usage snapshot says at least
   * this share (0..1) of its current window is used, with the reset still ahead,
   * is tried after the others for this request. Nothing is parked or persisted.
   * A value of 1 or more turns it off.
   */
  preemptAtUtilisation: number;
  /**
   * Continue a streamed answer on the next account when the current one hits a
   * limit mid-stream (after text, with no tool call open). Off by default: the
   * join between two accounts' text can occasionally show a seam.
   */
  resumeInterrupted: boolean;
  /** Per-provider overrides. */
  providers?: Partial<Record<ProviderId, Partial<Omit<FailoverPolicy, 'providers'>>>>;
}

export const DEFAULT_POLICY: FailoverPolicy = {
  defaultRateLimitCooldownMs: 60_000,
  defaultQuotaCooldownMs: 30 * 60_000,
  billingCooldownMs: 24 * 60 * 60_000,
  overloadCooldownMs: 15_000,
  overloadRetries: 1,
  maxCooldownMs: 7 * 24 * 60 * 60_000,
  requestTimeoutMs: 10 * 60_000,
  autoReturn: true,
  preemptAtUtilisation: 0.95,
  resumeInterrupted: false,
};

/* ------------------------------------------------------------------ */
/* Doctor                                                              */
/* ------------------------------------------------------------------ */

export interface CliProbe {
  provider: ProviderId;
  binary: string;
  found: boolean;
  path?: string;
  version?: string;
  homeEnv: string;
}

/* ------------------------------------------------------------------ */
/* Existing logins                                                     */
/* ------------------------------------------------------------------ */

/**
 * A vendor CLI already signed in at its default home on this machine. Found by
 * running the CLI's own status command; Iron-Proxy never reads its credential
 * files, and no email or account identifier is ever part of this record.
 */
export interface DiscoveredLogin {
  provider: ProviderId;
  /** The vendor CLI's binary name, e.g. `claude`. */
  binary: string;
  /** Absolute path of the CLI's default home directory. */
  home: string;
  /** Whether the binary is on PATH. */
  installed: boolean;
  /** What the CLI's own status command said about that home. */
  status: 'ok' | 'unauthenticated' | 'unknown';
  /** Set when a profile already uses this home. */
  adoptedProfileId?: string;
  /** A title not yet taken, e.g. "Claude (existing login)". */
  suggestedTitle: string;
}

export interface AdoptLoginInput {
  provider: ProviderId;
  /** The existing CLI home to use as-is. */
  home: string;
  title?: string;
}

/* ------------------------------------------------------------------ */
/* Usage history                                                       */
/* ------------------------------------------------------------------ */

/**
 * One finished request, as the usage history keeps it: when, how long, and the
 * token counts the provider reported. Never prompt text, output, secrets or emails.
 */
export interface UsageRequestRecord {
  /** When the request finished, ISO 8601. */
  at: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/** One park: when, why (the signal kind only) and until when. */
export interface UsageParkRecord {
  at: string;
  kind: QuotaSignalKind;
  until?: string;
}

/** One utilisation sample a lane reported (0..1 of the current window). */
export interface UsageSampleRecord {
  at: string;
  utilisation: number;
  resetAt?: string;
}

/** Everything the usage history holds for one profile, oldest first. */
export interface ProfileUsageHistory {
  requests: UsageRequestRecord[];
  parks: UsageParkRecord[];
  samples: UsageSampleRecord[];
}

export type UsageWindow = '1h' | '5h' | '24h' | '7d';

export const USAGE_WINDOWS: readonly UsageWindow[] = ['1h', '5h', '24h', '7d'] as const;

export interface UsageWindowTotals {
  requests: number;
  /** Sum of the input tokens providers reported; requests without a count add nothing. */
  inputTokens: number;
  outputTokens: number;
}

/**
 * How long the current window lasts at the recent pace. Only produced from at
 * least three utilisation samples of the current window with a rising trend.
 */
export interface UsageEstimate {
  minutesLeft: number;
  basis: 'utilisation-trend';
  /** `medium` with six or more samples spanning ten minutes or more, else `low`. */
  confidence: 'low' | 'medium';
}

/** One profile's usage, as `IronProxy.usageReport()` returns it. */
export interface UsageReport {
  profileId: string;
  windows: Record<UsageWindow, UsageWindowTotals>;
  /** Parks in the last seven days. */
  parks7d: number;
  lastParkedAt?: string;
  /** The latest utilisation sample of the current window, when there is one. */
  utilisation?: number;
  resetAt?: string;
  estimate?: UsageEstimate;
}
