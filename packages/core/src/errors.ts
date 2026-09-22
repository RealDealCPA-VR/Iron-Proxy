import type { ProviderId, QuotaSignal, SerializedError } from './types.js';

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

export class IronProxyError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'IronProxyError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details ?? {};
  }

  toJSON(): SerializedError {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export class NoProfileError extends IronProxyError {
  constructor(provider: ProviderId) {
    super('NO_PROFILE', `No enabled profile for provider "${provider}". Add one and log in.`, {
      details: { provider },
    });
    this.name = 'NoProfileError';
  }
}

export class ProfileNotFoundError extends IronProxyError {
  constructor(profileId: string) {
    super('PROFILE_NOT_FOUND', `Profile "${profileId}" does not exist.`, {
      details: { profileId },
    });
    this.name = 'ProfileNotFoundError';
  }
}

export class AuthRequiredError extends IronProxyError {
  constructor(profileId: string, message = 'This account needs to log in again.') {
    super('AUTH_REQUIRED', message, { details: { profileId } });
    this.name = 'AuthRequiredError';
  }
}

/** One account hit a quota signal. Internal to the router, surfaced only with `strict`. */
export class QuotaExceededError extends IronProxyError {
  readonly signal: QuotaSignal;
  readonly profileId: string;
  constructor(profileId: string, signal: QuotaSignal) {
    super('QUOTA_EXCEEDED', signal.message ?? `Account exhausted (${signal.kind}).`, {
      retryable: true,
      details: { profileId, signal },
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
    super(
      'ALL_PROFILES_EXHAUSTED',
      `Every ${provider} account is parked.${when} Iron-Proxy never switches providers on its own.`,
      { retryable: true, details: { provider, earliestResetAt, tried } },
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
  ) {
    super(code, message, { details });
    this.name = 'CliError';
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof IronProxyError) return err.toJSON();
  if (err instanceof Error) {
    const aborted = err.name === 'AbortError';
    return {
      name: err.name,
      message: err.message,
      code: aborted ? 'ABORTED' : 'PROVIDER_ERROR',
      retryable: false,
    };
  }
  return { name: 'Error', message: String(err), code: 'PROVIDER_ERROR', retryable: false };
}
