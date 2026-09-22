import { describe, expect, it } from 'vitest';
import {
  detectFromCliOutput,
  detectFromHttp,
  headersFrom,
  usageFromHeaders,
} from '../src/quota/detect.js';

const now = new Date('2026-09-22T14:00:00.000Z').getTime();

describe('detectFromHttp', () => {
  it('anthropic 429 with reset headers -> rate-limit with resetAt', () => {
    const h = headersFrom({
      'anthropic-ratelimit-requests-reset': '2026-09-22T14:05:00Z',
      'retry-after': '300',
    });
    const sig = detectFromHttp(
      'anthropic',
      429,
      h,
      '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
      now,
    );
    expect(sig?.kind).toBe('rate-limit');
    expect(sig?.resetAt).toBe('2026-09-22T14:05:00.000Z');
  });
  it('openai 429 insufficient_quota -> billing', () => {
    const sig = detectFromHttp(
      'openai',
      429,
      headersFrom({}),
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      now,
    );
    expect(sig?.kind).toBe('billing');
  });
  it('openai 429 with x-ratelimit-reset-tokens "6m0s"', () => {
    const sig = detectFromHttp(
      'openai',
      429,
      headersFrom({ 'x-ratelimit-reset-tokens': '6m0s', 'x-ratelimit-reset-requests': '1s' }),
      '{"error":{"code":"rate_limit_exceeded"}}',
      now,
    );
    expect(sig?.kind).toBe('rate-limit');
    expect(sig?.resetAt).toBe(new Date(now + 360_000).toISOString());
  });
  it('google 429 with retryDelay in body', () => {
    const body =
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"31s"}]}}';
    const sig = detectFromHttp('google', 429, headersFrom({}), body, now);
    expect(sig?.kind).toBe('rate-limit');
    expect(sig?.resetAt).toBe(new Date(now + 31_000).toISOString());
  });
  it('retry-after only -> retryAfterMs', () => {
    const sig = detectFromHttp('xai', 429, headersFrom({ 'retry-after': '20' }), '', now);
    expect(sig?.retryAfterMs).toBe(20_000);
  });
  it('401 -> auth-expired; 529 -> overloaded; 400 billing -> billing; 500 generic -> undefined', () => {
    expect(detectFromHttp('anthropic', 401, headersFrom({}), 'invalid x-api-key', now)?.kind).toBe(
      'auth-expired',
    );
    expect(
      detectFromHttp(
        'anthropic',
        529,
        headersFrom({}),
        '{"error":{"type":"overloaded_error"}}',
        now,
      )?.kind,
    ).toBe('overloaded');
    expect(
      detectFromHttp(
        'anthropic',
        400,
        headersFrom({}),
        'Your credit balance is too low to access the Anthropic API.',
        now,
      )?.kind,
    ).toBe('billing');
    expect(detectFromHttp('anthropic', 500, headersFrom({}), 'boom', now)).toBeUndefined();
    expect(
      detectFromHttp('anthropic', 400, headersFrom({}), 'invalid_request_error: max_tokens', now),
    ).toBeUndefined();
  });
  it('accepts a real Headers object', () => {
    const h = new Headers({ 'Retry-After': '5' });
    expect(detectFromHttp('openai', 429, headersFrom(h), '', now)?.retryAfterMs).toBe(5000);
  });
});

describe('detectFromCliOutput', () => {
  it('claude usage limit with reset clock', () => {
    const sig = detectFromCliOutput(
      'anthropic',
      "You've hit your usage limit. Your limit will reset at 3pm.",
      now,
    );
    expect(sig?.kind).toBe('quota-exhausted');
    expect(sig?.resetAt).toBeDefined();
  });
  it('codex weekly limit', () => {
    expect(
      detectFromCliOutput(
        'openai',
        'You have hit your weekly limit. Try again in 2 hours 10 minutes.',
        now,
      ),
    ).toMatchObject({
      kind: 'quota-exhausted',
      resetAt: new Date(now + 7_800_000).toISOString(),
    });
  });
  it('auth and billing and overload and nothing', () => {
    expect(detectFromCliOutput('xai', 'You are not authenticated.', now)?.kind).toBe(
      'auth-expired',
    );
    expect(detectFromCliOutput('anthropic', 'Your credit balance is too low', now)?.kind).toBe(
      'billing',
    );
    expect(detectFromCliOutput('anthropic', 'API overloaded, please retry', now)?.kind).toBe(
      'overloaded',
    );
    expect(detectFromCliOutput('anthropic', 'Here is your answer: 42', now)).toBeUndefined();
    expect(detectFromCliOutput('anthropic', '', now)).toBeUndefined();
  });
  it('rate limit without a usage word is a rate-limit', () => {
    expect(detectFromCliOutput('openai', 'Error: too many requests (429)', now)?.kind).toBe(
      'rate-limit',
    );
  });
});

describe('usageFromHeaders', () => {
  it('anthropic', () => {
    const u = usageFromHeaders(
      'anthropic',
      headersFrom({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': '10',
        'anthropic-ratelimit-requests-reset': '2026-09-22T14:01:00Z',
      }),
      now,
    );
    expect(u).toMatchObject({
      requestsLimit: 50,
      requestsRemaining: 10,
      utilisation: 0.8,
      resetAt: '2026-09-22T14:01:00.000Z',
    });
  });
  it('openai', () => {
    const u = usageFromHeaders(
      'openai',
      headersFrom({ 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '250' }),
      now,
    );
    expect(u?.utilisation).toBe(0.75);
  });
  it('none', () => {
    expect(usageFromHeaders('openai', headersFrom({}), now)).toBeUndefined();
    expect(
      usageFromHeaders('google', headersFrom({ 'x-ratelimit-limit-tokens': '1' }), now),
    ).toBeUndefined();
  });
});
