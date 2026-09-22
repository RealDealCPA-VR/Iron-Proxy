import type { ProviderId, QuotaSignal, UsageSnapshot } from '../types.js';
import { parseDurationMs, parseResetAt } from '../util.js';

/** Minimal header accessor so tests and the CLI lane need no real Headers object. */
export type HeaderGetter = (name: string) => string | null | undefined;

export function headersFrom(
  h: Headers | Record<string, string | string[] | undefined>,
): HeaderGetter {
  if (typeof (h as Headers).get === 'function') return (n) => (h as Headers).get(n);
  const rec = h as Record<string, string | string[] | undefined>;
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(rec)) {
    if (v === undefined) continue;
    lower.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v);
  }
  return (n) => lower.get(n.toLowerCase());
}

function excerpt(text: string | undefined, max = 240): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Detect a quota signal from an HTTP response. Returns undefined when the
 * response is either fine or a genuine (non-quota) error the caller should surface.
 */
export function detectFromHttp(
  provider: ProviderId,
  status: number,
  headers: HeaderGetter,
  bodyText: string | undefined,
  now: number = Date.now(),
): QuotaSignal | undefined {
  const body = bodyText ?? '';
  const lower = body.toLowerCase();
  const retryAfter = headers('retry-after');
  const retryAfterMs = retryAfter
    ? /^\d+$/.test(retryAfter.trim())
      ? Number(retryAfter) * 1000
      : Math.max(0, (new Date(retryAfter).getTime() || now) - now)
    : undefined;

  if (status === 401 || status === 403) {
    if (
      /invalid.*(api key|token)|expired|unauthorized|authentication|permission/i.test(body) ||
      status === 401
    ) {
      return {
        kind: 'auth-expired',
        source: 'status',
        message: excerpt(body) ?? 'Authentication failed.',
      };
    }
  }

  if (status === 402) {
    return { kind: 'billing', source: 'status', message: excerpt(body) ?? 'Payment required.' };
  }

  if (status === 429) {
    // Billing-flavoured 429s: OpenAI insufficient_quota, Anthropic credit balance.
    if (
      /insufficient_quota|exceeded your current quota|credit balance|billing|payment|plan.*upgrade/i.test(
        body,
      )
    ) {
      return {
        kind: /insufficient_quota|credit balance/.test(lower) ? 'billing' : 'quota-exhausted',
        source: 'body',
        message: excerpt(body),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    const resetAt = resetFromHeaders(provider, headers, now) ?? resetFromBody(body, now);
    const sig: QuotaSignal = {
      kind: 'rate-limit',
      source: retryAfter || resetAt ? 'header' : 'status',
    };
    if (resetAt) sig.resetAt = resetAt;
    else if (retryAfterMs !== undefined) sig.retryAfterMs = retryAfterMs;
    const msg = excerpt(body);
    if (msg) sig.message = msg;
    return sig;
  }

  if (status === 529 || status === 503 || (status === 500 && /overloaded/.test(lower))) {
    const sig: QuotaSignal = {
      kind: 'overloaded',
      source: 'status',
      message: excerpt(body) ?? 'Provider overloaded.',
    };
    if (retryAfterMs !== undefined) sig.retryAfterMs = retryAfterMs;
    return sig;
  }

  if (status === 400 && /credit balance is too low|billing/i.test(body)) {
    return { kind: 'billing', source: 'body', message: excerpt(body) };
  }

  return undefined;
}

function resetFromHeaders(
  provider: ProviderId,
  headers: HeaderGetter,
  now: number,
): string | undefined {
  switch (provider) {
    case 'anthropic': {
      // RFC 3339 instants. Take the furthest of the exhausted windows.
      const candidates = [
        headers('anthropic-ratelimit-requests-reset'),
        headers('anthropic-ratelimit-input-tokens-reset'),
        headers('anthropic-ratelimit-output-tokens-reset'),
        headers('anthropic-ratelimit-tokens-reset'),
        headers('anthropic-ratelimit-unified-reset'),
      ];
      let best: number | undefined;
      for (const c of candidates) {
        const t = c ? new Date(c).getTime() : NaN;
        if (!Number.isNaN(t) && (best === undefined || t > best)) best = t;
      }
      return best !== undefined ? new Date(best).toISOString() : undefined;
    }
    case 'openai':
    case 'xai':
    case 'openai-compatible': {
      // Relative durations like "6m0s", "1.2s". Take the longer.
      const a = parseDurationMs(headers('x-ratelimit-reset-requests'));
      const b = parseDurationMs(headers('x-ratelimit-reset-tokens'));
      const ms = Math.max(a ?? 0, b ?? 0);
      return ms > 0 ? new Date(now + ms).toISOString() : undefined;
    }
    case 'google':
      return undefined; // Google puts retryDelay in the body, handled below.
  }
}

function resetFromBody(body: string, now: number): string | undefined {
  // Google: "retryDelay": "31s"
  const g = /"retryDelay"\s*:\s*"([^"]+)"/.exec(body);
  if (g) {
    const ms = parseDurationMs(g[1]);
    if (ms) return new Date(now + ms).toISOString();
  }
  // Generic: "try again in 20s" / "retry after 2 minutes"
  const t = /(?:try again|retry)\s+(?:in|after)\s+([\d.]+\s*[a-z]+(?:\s*[\d.]+\s*[a-z]+)?)/i.exec(
    body,
  );
  if (t) {
    const ms = parseDurationMs(t[1]);
    if (ms) return new Date(now + ms).toISOString();
  }
  // Generic: "resets at 3pm" / "resets 15:30"
  const r = /resets?\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i.exec(body);
  if (r) return parseResetAt(r[1], now);
  return undefined;
}

/**
 * Detect a quota signal from the text a vendor CLI printed. Patterns are
 * deliberately broad and case-insensitive because CLI wording changes often.
 */
export function detectFromCliOutput(
  provider: ProviderId,
  text: string,
  now: number = Date.now(),
): QuotaSignal | undefined {
  const t = text.toLowerCase();
  if (!t.trim()) return undefined;

  const authy =
    /not (?:logged in|authenticated)|please (?:log ?in|sign in|run .*login)|invalid (?:api key|token)|token (?:has )?expired|authentication (?:failed|required)|unauthorized|re-?authenticat/i;
  const limit =
    /(?:usage|rate|weekly|daily|monthly|session|5-hour|five-hour) limit|limit (?:reached|exceeded|hit)|you(?:'ve| have) hit your|out of (?:credits|quota)|quota (?:exceeded|exhausted)|too many requests|resource_exhausted|429/i;
  const overload = /overloaded|capacity|529|503|temporarily unavailable|service unavailable/i;
  const billing =
    /credit balance|insufficient[_ ]quota|billing|payment required|upgrade your plan/i;

  if (billing.test(t)) return { kind: 'billing', source: 'cli-output', message: excerpt(text) };
  if (authy.test(t)) return { kind: 'auth-expired', source: 'cli-output', message: excerpt(text) };
  if (limit.test(t)) {
    const resetAt = resetFromBody(text, now);
    const sig: QuotaSignal = {
      kind: /usage|weekly|daily|monthly|session|5-hour|five-hour|quota|credits/.test(t)
        ? 'quota-exhausted'
        : 'rate-limit',
      source: 'cli-output',
      message: excerpt(text),
    };
    if (resetAt) sig.resetAt = resetAt;
    return sig;
  }
  if (overload.test(t)) return { kind: 'overloaded', source: 'cli-output', message: excerpt(text) };
  void provider;
  return undefined;
}

/** Read remaining-quota headers into a UsageSnapshot when the provider sends them. */
export function usageFromHeaders(
  provider: ProviderId,
  headers: HeaderGetter,
  now: number = Date.now(),
): UsageSnapshot | undefined {
  const num = (n: string | null | undefined) =>
    n !== undefined && n !== null && n !== '' ? Number(n) : undefined;
  const snap: UsageSnapshot = { observedAt: new Date(now).toISOString() };
  let any = false;
  if (provider === 'anthropic') {
    const rl = num(headers('anthropic-ratelimit-requests-limit'));
    const rr = num(headers('anthropic-ratelimit-requests-remaining'));
    const tl =
      num(headers('anthropic-ratelimit-tokens-limit')) ??
      num(headers('anthropic-ratelimit-input-tokens-limit'));
    const tr =
      num(headers('anthropic-ratelimit-tokens-remaining')) ??
      num(headers('anthropic-ratelimit-input-tokens-remaining'));
    if (rl !== undefined) {
      snap.requestsLimit = rl;
      any = true;
    }
    if (rr !== undefined) {
      snap.requestsRemaining = rr;
      any = true;
    }
    if (tl !== undefined) {
      snap.tokensLimit = tl;
      any = true;
    }
    if (tr !== undefined) {
      snap.tokensRemaining = tr;
      any = true;
    }
    const reset = resetFromHeaders(provider, headers, now);
    if (reset) {
      snap.resetAt = reset;
      any = true;
    }
  } else if (provider !== 'google') {
    const rl = num(headers('x-ratelimit-limit-requests'));
    const rr = num(headers('x-ratelimit-remaining-requests'));
    const tl = num(headers('x-ratelimit-limit-tokens'));
    const tr = num(headers('x-ratelimit-remaining-tokens'));
    if (rl !== undefined) {
      snap.requestsLimit = rl;
      any = true;
    }
    if (rr !== undefined) {
      snap.requestsRemaining = rr;
      any = true;
    }
    if (tl !== undefined) {
      snap.tokensLimit = tl;
      any = true;
    }
    if (tr !== undefined) {
      snap.tokensRemaining = tr;
      any = true;
    }
    const reset = resetFromHeaders(provider, headers, now);
    if (reset) {
      snap.resetAt = reset;
      any = true;
    }
  }
  if (!any) return undefined;
  const ratios: number[] = [];
  if (snap.requestsLimit && snap.requestsRemaining !== undefined)
    ratios.push(1 - snap.requestsRemaining / snap.requestsLimit);
  if (snap.tokensLimit && snap.tokensRemaining !== undefined)
    ratios.push(1 - snap.tokensRemaining / snap.tokensLimit);
  if (ratios.length) snap.utilisation = Math.min(1, Math.max(0, Math.max(...ratios)));
  return snap;
}
