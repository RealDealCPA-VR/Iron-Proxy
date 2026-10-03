import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IronEvent, LaneKind, Profile } from '@iron-proxy/core';
import { HttpIronClient, HttpIronClientError } from '../src/client.js';
import { harness, type Harness } from './helpers.js';

/** The external-executor API over HTTP: /iron/pick, /iron/profiles/:id/signal, /finished. */

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
  await rm(h.dir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${h.token}` });
const get = (path: string, headers: Record<string, string> = auth()) =>
  fetch(`${h.url}${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = auth()) =>
  fetch(`${h.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** Put a profile straight into the store, so no background status check runs a real vendor CLI. */
async function put(
  id: string,
  order: number,
  extra: { lane?: LaneKind; status?: 'ready' | 'parked' | 'unauthenticated'; until?: string } = {},
): Promise<Profile> {
  const lane = extra.lane ?? 'cli';
  const p: Profile = {
    id,
    title: `T ${id}`,
    provider: 'anthropic',
    lane,
    order,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...(lane === 'cli' ? { cli: { home: join(h.dir, id) } } : { apiKey: { secretRef: `k:${id}` } }),
  };
  await h.iron.profiles.put(p);
  await h.iron.states.put({
    profileId: id,
    status: extra.status ?? 'ready',
    served: 0,
    ...(extra.until ? { parkedUntil: extra.until } : {}),
  });
  return p;
}

type IronBody = { iron: { code: string; details: Record<string, unknown>; hint?: string } };

describe('external-executor routes', () => {
  it('require the bearer token', async () => {
    await put('a', 0);
    expect((await get('/iron/pick?provider=anthropic', {})).status).toBe(401);
    expect((await post('/iron/profiles/a/signal', { status: 429 }, {})).status).toBe(401);
    expect((await post('/iron/profiles/a/finished', {}, {})).status).toBe(401);
    expect(
      (await post('/iron/profiles/a/finished', {}, { authorization: 'Bearer nope' })).status,
    ).toBe(401);
    expect((await h.iron.allStates()).a).toMatchObject({ status: 'ready', served: 0 });
  });
});

describe('GET /iron/pick', () => {
  it('answers the usable account and the env that runs its vendor CLI as it', async () => {
    await put('a', 0, { status: 'parked', until: new Date(Date.now() + 60_000).toISOString() });
    await put('b', 1);
    const res = await get('/iron/pick?provider=anthropic');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: Profile;
      env: { set: Record<string, string>; unset: string[] };
    };
    expect(body.profile.id).toBe('b');
    expect(body.env.set).toEqual({ CLAUDE_CONFIG_DIR: join(h.dir, 'b') });
    expect(body.env.unset).toContain('ANTHROPIC_API_KEY');
    expect(body.env.unset).toContain('OPENAI_API_KEY');
  });

  it('filters by lane (default cli); env is null for a non-cli pick', async () => {
    await put('key', 0, { lane: 'api-key' });
    const none = await get('/iron/pick?provider=anthropic');
    expect(none.status).toBe(404);
    expect(((await none.json()) as IronBody).iron.code).toBe('NO_PROFILE');
    const res = await get('/iron/pick?provider=anthropic&lane=api-key');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profile: { id: 'key' }, env: null });
    expect((await get('/iron/pick?provider=anthropic&lane=any')).status).toBe(200);
  });

  it('ALL_PROFILES_EXHAUSTED carries the earliest reset (details.resetAt) and retry-after', async () => {
    const soon = new Date(Date.now() + 600_000).toISOString();
    await put('a', 0, { status: 'parked', until: new Date(Date.now() + 3_600_000).toISOString() });
    await put('b', 1, { status: 'parked', until: soon });
    const res = await get('/iron/pick?provider=anthropic');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(590);
    const body = (await res.json()) as IronBody & { error: { message: string; code: string } };
    expect(body.error.code).toBe('ALL_PROFILES_EXHAUSTED');
    expect(body.iron).toMatchObject({
      code: 'ALL_PROFILES_EXHAUSTED',
      retryable: true,
      details: { provider: 'anthropic', resetAt: soon, earliestResetAt: soon },
    });
    expect(body.iron.hint).toContain('add another anthropic account');
  });

  it('AUTH_REQUIRED names the account that needs sign-in; NO_PROFILE when there is none', async () => {
    await put('a', 0, { status: 'unauthenticated' });
    const res = await get('/iron/pick?provider=anthropic');
    expect(res.status).toBe(401);
    expect(((await res.json()) as IronBody).iron).toMatchObject({
      code: 'AUTH_REQUIRED',
      details: { profileId: 'a', title: 'T a' },
    });
    const none = await get('/iron/pick?provider=openai');
    expect(none.status).toBe(404);
    expect(((await none.json()) as IronBody).iron).toMatchObject({
      code: 'NO_PROFILE',
      details: { provider: 'openai' },
    });
  });

  it('a missing or unknown provider or lane is a 400', async () => {
    for (const q of ['', '?provider=', '?provider=nope', '?provider=anthropic&lane=bogus']) {
      const res = await get(`/iron/pick${q}`);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as IronBody).iron.code).toBe('INVALID_REQUEST');
    }
  });
});

describe('POST /iron/profiles/:id/signal', () => {
  it('parks on a 429 with the Anthropic reset header and emits the park', async () => {
    await put('a', 0);
    const events: IronEvent[] = [];
    h.iron.events.onAny((e) => events.push(e));
    const reset = new Date(Date.now() + 3_600_000).toISOString();
    const res = await post('/iron/profiles/a/signal', {
      status: 429,
      headers: { 'anthropic-ratelimit-requests-reset': reset },
      text: '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parked: boolean;
      signal: { kind: string; resetAt?: string };
      state: { status: string; parkedUntil?: string };
    };
    expect(body).toMatchObject({
      parked: true,
      signal: { kind: 'rate-limit', resetAt: reset },
      state: { status: 'parked', parkedUntil: reset },
    });
    expect(events.some((e) => e.type === 'profile.parked' && e.profileId === 'a')).toBe(true);
  });

  it('answers { parked: false } for a model-access 403', async () => {
    await put('a', 0);
    const res = await post('/iron/profiles/a/signal', {
      status: 403,
      text: '{"type":"error","error":{"type":"permission_error","message":"does not have access to this model"}}',
    });
    expect(await res.json()).toEqual({ parked: false });
    expect((await h.iron.allStates()).a?.status).toBe('ready');
  });

  it('rejects bad bodies with 400 and an unknown profile with 404', async () => {
    await put('a', 0);
    for (const body of ['{not json', '[1]', '"x"', {}, { status: 'x' }, { text: 1 }]) {
      const res = await post('/iron/profiles/a/signal', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as IronBody).iron.code).toBe('INVALID_REQUEST');
    }
    expect((await post('/iron/profiles/nope/signal', { status: 429 })).status).toBe(404);
    expect((await h.iron.allStates()).a?.status).toBe('ready');
  });
});

describe('POST /iron/profiles/:id/finished', () => {
  it('records the success: active, served++, request.finished with usage', async () => {
    await put('a', 0);
    const events: IronEvent[] = [];
    h.iron.events.onAny((e) => events.push(e));
    const res = await post('/iron/profiles/a/finished', {
      usage: { inputTokens: 10, outputTokens: 4 },
      durationMs: 900,
      model: 'claude-x',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: { status: 'active', served: 1 } });
    expect(events.find((e) => e.type === 'request.finished')).toMatchObject({
      profileId: 'a',
      durationMs: 900,
      usage: { inputTokens: 10, outputTokens: 4 },
      model: 'claude-x',
    });
    const [report] = await h.iron.usageReport({ profileId: 'a' });
    expect(report?.windows['1h']).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 4 });
  });

  it('rejects bad bodies with 400', async () => {
    await put('a', 0);
    for (const body of [
      '{not json',
      '[]',
      { usage: { inputTokens: 1 } },
      { durationMs: 'slow' },
      { model: 1 },
    ]) {
      const res = await post('/iron/profiles/a/finished', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.iron.allStates()).a?.served).toBe(0);
  });
});

describe('HttpIronClient external-executor methods', () => {
  it('pick, signal and finished round-trip; errors carry code, details and hint', async () => {
    const client = new HttpIronClient(h.url, h.token);
    const e1 = await client.pick('anthropic').catch((x: unknown) => x);
    expect(e1).toBeInstanceOf(HttpIronClientError);
    expect(e1).toMatchObject({ status: 404, code: 'NO_PROFILE' });

    await put('a', 0);
    const picked = await client.pick('anthropic');
    expect(picked.profile.id).toBe('a');
    expect(picked.env?.set.CLAUDE_CONFIG_DIR).toBe(join(h.dir, 'a'));
    await expect(client.pick('anthropic', { lane: 'api-key' })).rejects.toMatchObject({
      code: 'NO_PROFILE',
    });

    expect((await client.finished('a', { durationMs: 5 })).state).toMatchObject({
      status: 'active',
      served: 1,
    });
    const s = await client.signal('a', { text: 'Claude usage limit reached' });
    expect(s).toMatchObject({ parked: true, signal: { kind: 'quota-exhausted' } });

    const e2 = (await client.pick('anthropic').catch((x: unknown) => x)) as HttpIronClientError;
    expect(e2.code).toBe('ALL_PROFILES_EXHAUSTED');
    expect(typeof e2.details.resetAt).toBe('string');
    expect(e2.hint).toBeTruthy();
    expect(await client.signal('a', { status: 403, text: 'Request not allowed' })).toEqual({
      parked: false,
    });
  });
});
