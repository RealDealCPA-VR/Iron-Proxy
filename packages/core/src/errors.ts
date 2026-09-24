import type { ProviderId, QuotaSignal, SerializedError } from './types.js';
import { redactSecrets } from './util.js';

export type ErrorCode =
  | 'NO_PROFILE'
  | 'PROFILE_NOT_FOUND'
  | 'PROVIDER_MISMATCH'
  | 'AUTH_REQUIRED'
  | 'QUOTA_EXCEEDED'
  | 'ALL_PROFILES_EXHAUSTED'
  | 'PROVIDER_ERROR'
  | 'CLI_NOT_FOUND'
  | 'CLI_FAILED'
  | 'VAULT_ERROR'
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'STREAM_INTERRUPTED'
  | 'UNSUPPORTED';

/* ------------------------------------------------------------------ */
/* Hints: one short imperative sentence telling the user what to do.   */
/* ------------------------------------------------------------------ */

/** The official install command (or instruction) for each vendor CLI, keyed by binary name. */
export const CLI_INSTALL_HINTS: Readonly<Record<string, string>> = {
  claude: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
  codex: 'Install the Codex CLI: npm install -g @openai/codex',
  gemini: 'Install the Gemini CLI: npm install -g @google/gemini-cli',
  grok: 'Install Grok Build from xAI, then run grok --version',
};

/** The hint an error carries when its raiser gives no more specific one. */
export const DEFAULT_HINTS: Readonly<Record<ErrorCode, string>> = {
  NO_PROFILE:
    'Add an account: iron-proxy profiles add --provider <provider> --lane cli --title "...", or \'Add account\' in the switcher.',
  PROFILE_NOT_FOUND:
    'Run iron-proxy profiles list (or open the switcher) and use one of the ids shown there.',
  PROVIDER_MISMATCH:
    'Pick an account of the provider the request is for; Iron-Proxy never switches providers.',
  AUTH_REQUIRED:
    "Log the account in again: iron-proxy login <id>, or 'Log in' on it in the switcher.",
  QUOTA_EXCEEDED:
    'Wait for the reset, or resend without strict so the next account of the same provider takes it.',
  ALL_PROFILES_EXHAUSTED:
    'Wait for the earliest reset, or add another account of this provider: iron-proxy profiles add.',
  PROVIDER_ERROR:
    "Retry in a moment; if it keeps failing, check the provider's status page and iron-proxy status.",
  CLI_NOT_FOUND:
    'Install the vendor CLI and put it on PATH, then run iron-proxy doctor to confirm.',
  CLI_FAILED:
    'Run iron-proxy doctor, then try the same step yourself with iron-proxy login <id> --terminal.',
  VAULT_ERROR:
    'The vault key changed or a different key protector is in use: start Iron-Proxy the way it was set up (same app, same OS user), or re-enter the API keys.',
  INVALID_REQUEST:
    'Check the command or request against iron-proxy --help and docs/ADOPTING.md, then try again.',
  TIMEOUT:
    'Retry; if it keeps timing out, raise requestTimeoutMs in the failover policy or pass timeoutMs.',
  ABORTED: 'The request was cancelled; send it again if you still need it.',
  STREAM_INTERRUPTED: 'Resend; the next account will take it.',
  UNSUPPORTED: 'Use a lane that supports this, or register one with registry.addLane().',
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Hints never carry secrets or account emails, whatever went into them. */
export function sanitizeHint(hint: string): string {
  return redactSecrets(hint).replace(EMAIL, '[email]').trim();
}

/** The install hint for a vendor CLI binary (a bare name or a path), or a generic one. */
export function installHint(binary: string | undefined): string {
  const base = (binary ?? '')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  const known = CLI_INSTALL_HINTS[base];
  if (known) return known;
  return `Install ${base ? `"${base}"` : 'the vendor CLI'} and put it on PATH, then run iron-proxy doctor to confirm.`;
}

/** Local time for an ISO instant, for hints. */
function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function addAccountCommand(provider: string): string {
  return `iron-proxy profiles add --provider ${provider} --lane cli --title "..."`;
}

export class IronProxyError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  /** What the user should do next. Always set; never contains secrets or emails. */
  readonly hint: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
      /** Short imperative sentence. Defaults to the code's entry in DEFAULT_HINTS. */
      hint?: string;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'IronProxyError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details ?? {};
    this.hint = sanitizeHint(opts.hint ?? DEFAULT_HINTS[code] ?? DEFAULT_HINTS.PROVIDER_ERROR);
  }

  toJSON(): SerializedError {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      details: this.details,
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

export class NoProfileError extends IronProxyError {
  constructor(provider: ProviderId) {
    super('NO_PROFILE', `No enabled profile for provider "${provider}". Add one and log in.`, {
      details: { provider },
      hint: `Add a ${provider} account: ${addAccountCommand(provider)} (then iron-proxy login <id>), or 'Add account' in the switcher.`,
    });
    this.name = 'NoProfileError';
  }
}

export class ProfileNotFoundError extends IronProxyError {
  constructor(profileId: string) {
    super('PROFILE_NOT_FOUND', `Profile "${profileId}" does not exist.`, {
      details: { profileId },
      hint: 'Run iron-proxy profiles list (or open the switcher) and use one of the ids shown there.',
    });
    this.name = 'ProfileNotFoundError';
  }
}

export interface AuthRequiredContext {
  /** The profile's user-facing title, when known. */
  title?: string;
  /** The profile's lane, to say how to sign in again. */
  lane?: string;
}

export class AuthRequiredError extends IronProxyError {
  constructor(
    profileId: string,
    message = 'This account needs to log in again.',
    ctx: AuthRequiredContext = {},
  ) {
    const who = ctx.title ? `"${ctx.title}"` : `account ${profileId}`;
    const hint =
      ctx.lane === 'api-key'
        ? `Enter the API key for ${who} again: 'Set API key' on it in the switcher.`
        : `Log ${who} in again: iron-proxy login ${profileId}, or 'Log in' on it in the switcher.`;
    super('AUTH_REQUIRED', message, { details: { profileId }, hint });
    this.name = 'AuthRequiredError';
  }
}

/** One account hit a quota signal. Internal to the router, surfaced only with `strict`. */
export class QuotaExceededError extends IronProxyError {
  readonly signal: QuotaSignal;
  readonly profileId: string;
  constructor(profileId: string, signal: QuotaSignal, provider?: ProviderId) {
    const when = signal.resetAt ? ` (it resets at ${localTime(signal.resetAt)})` : '';
    super('QUOTA_EXCEEDED', signal.message ?? `Account exhausted (${signal.kind}).`, {
      retryable: true,
      details: { profileId, signal },
      hint: `This request was pinned with strict, so Iron-Proxy did not switch: wait for the reset${when}, or resend without strict so the next ${provider ?? 'same-provider'} account takes it.`,
    });
    this.name = 'QuotaExceededError';
    this.signal = signal;
    this.profileId = profileId;
  }
}

/** Every enabled account of the provider is parked. The host decides what happens next. */
export class AllProfilesExhaustedError extends IronProxyError {
  readonly provider: ProviderId;
  readonly earliestResetAt: string | undefined;
  constructor(provider: ProviderId, earliestResetAt: string | undefined, tried: string[]) {
    const when = earliestResetAt ? ` Earliest reset: ${earliestResetAt}.` : '';
    const wait = earliestResetAt
      ? `Wait until ${localTime(earliestResetAt)} for the first reset`
      : 'Wait for the first account to reset';
    super(
      'ALL_PROFILES_EXHAUSTED',
      `Every ${provider} account is parked.${when} Iron-Proxy never switches providers on its own.`,
      {
        retryable: true,
        details: { provider, earliestResetAt, tried },
        hint: `${wait}, or add another ${provider} account: ${addAccountCommand(provider)}.`,
      },
    );
    this.name = 'AllProfilesExhaustedError';
    this.provider = provider;
    this.earliestResetAt = earliestResetAt;
  }
}

export class ProviderError extends IronProxyError {
  readonly status: number | undefined;
  constructor(
    message: string,
    opts: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
      hint?: string;
    } = {},
  ) {
    super('PROVIDER_ERROR', message, opts);
    this.name = 'ProviderError';
    this.status = opts.status;
  }
}

export class CliError extends IronProxyError {
  constructor(
    code: 'CLI_NOT_FOUND' | 'CLI_FAILED',
    message: string,
    details: Record<string, unknown> = {},
    hint?: string,
  ) {
    const binary = typeof details.binary === 'string' ? details.binary : undefined;
    const resolved = hint ?? (code === 'CLI_NOT_FOUND' ? installHint(binary) : undefined);
    super(code, message, { details, ...(resolved !== undefined ? { hint: resolved } : {}) });
    this.name = 'CliError';
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof IronProxyError) return err.toJSON();
  if (err instanceof Error) {
    const aborted = err.name === 'AbortError';
    const code = aborted ? 'ABORTED' : 'PROVIDER_ERROR';
    return {
      name: err.name,
      message: err.message,
      code,
      retryable: false,
      hint: DEFAULT_HINTS[code],
    };
  }
  return {
    name: 'Error',
    message: String(err),
    code: 'PROVIDER_ERROR',
    retryable: false,
    hint: DEFAULT_HINTS.PROVIDER_ERROR,
  };
}
