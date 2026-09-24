import { AuthRequiredError, ProviderError } from '../../errors.js';
import { detectFromHttp, headersFrom, usageFromHeaders } from '../../quota/detect.js';
import type { ProviderId } from '../../types.js';
import { redactSecrets } from '../../util.js';
import { LaneQuotaSignal, type AttemptContext } from '../types.js';

export async function requireKey(ctx: AttemptContext): Promise<string> {
  const ref = ctx.profile.apiKey?.secretRef;
  const who = { title: ctx.profile.title, lane: ctx.profile.lane };
  if (!ref) throw new AuthRequiredError(ctx.profile.id, 'Profile has no API key configured.', who);
  const key = await ctx.vault.get(ref);
  if (!key)
    throw new AuthRequiredError(
      ctx.profile.id,
      'API key missing from the vault. Enter it again.',
      who,
    );
  return key;
}

export interface ApiCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * POST JSON, convert quota-shaped failures into LaneQuotaSignal and everything
 * else into ProviderError. On success, records usage headers and returns the Response.
 */
export async function postJson(
  provider: ProviderId,
  call: ApiCall,
  ctx: AttemptContext,
): Promise<Response> {
  let res: Response;
  try {
    res = await ctx.fetch(call.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...call.headers,
      },
      body: JSON.stringify(call.body),
      signal: ctx.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ProviderError(`Network error talking to ${provider}: ${(err as Error).message}`, {
      retryable: true,
      cause: err,
    });
  }
  const get = headersFrom(res.headers);
  const usage = usageFromHeaders(provider, get, ctx.now());
  if (usage) ctx.reportUsage(usage);
  if (res.ok) return res;

  const text = await res.text().catch(() => '');
  const signal = detectFromHttp(provider, res.status, get, text, ctx.now());
  if (signal) throw new LaneQuotaSignal(signal);
  throw new ProviderError(
    `${provider} returned HTTP ${res.status}: ${redactSecrets(text).slice(0, 500)}`,
    {
      status: res.status,
      retryable: res.status >= 500,
      details: { status: res.status },
    },
  );
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
