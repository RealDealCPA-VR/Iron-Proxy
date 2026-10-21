import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IronEvent, LaneKind, Profile, ProviderId, QuotaSignal } from '@iron-proxy/core';
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
  extra: {
    lane?: LaneKind;
    provider?: ProviderId;
    enabled?: boolean;
    status?: 'ready' | 'parked' | 'unauthenticated';
    until?: string;
    reason?: QuotaSignal;
  } = {},
): Promise<Profile> {
  const lane = extra.lane ?? 'cli';
  const p: Profile = {
    id,
    title: `T ${id}`,
    provider: extra.provider ?? 'anthropic',
    lane,
    order,
    enabled: extra.enabled ?? true,
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
    ...(extra.reason ? { parkedReason: extra.reason } : {}),
  });
  return p;
}

type IronBody = { iron: { code: string; details: Record<string, unknown>; hint?: string } };

describe('GET /iron/health advertises the executor API', () => {
  it('answers version and features (executor-v1, pick-profile, pick-pinned, plan-usage) without a token', async () => {
    const pkg = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    const res = await fetch(`${h.url}/iron/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: 'iron-proxy',
      profiles: 0,
      version: pkg.version,
      features: ['executor-v1', 'pick-profile', 'pick-pinned', 'plan-usage'],
    });
  });
});

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

describe('GET /iron/pick?profileId=', () => {
  type ErrBody = IronBody & {
    error: { message: string; code: string };
    iron: { retryable: boolean };
  };
  const pickById = async (q: string) => {
    const res = await get(`/iron/pick?${q}`);
    return { res, body: (await res.json()) as ErrBody & { profile?: Profile; env?: unknown } };
  };

  it('answers that account and its env even when another one comes first', async () => {
    await put('a', 0);
    await put('b', 1);
    const { res, body } = await pickById('provider=anthropic&profileId=b');
    expect(res.status).toBe(200);
    expect(body.profile?.id).toBe('b');
    expect(body).toMatchObject({ env: { set: { CLAUDE_CONFIG_DIR: join(h.dir, 'b') } } });
    await put('k', 2, { lane: 'api-key' });
    expect((await pickById('provider=anthropic&lane=api-key&profileId=k')).body).toMatchObject({
      profile: { id: 'k' },
      env: null,
    });
  });

  it('another provider, another lane or a disabled account is INVALID_REQUEST (400)', async () => {
    await put('a', 0);
    await put('o', 0, { provider: 'openai' });
    await put('k', 1, { lane: 'api-key' });
    await put('off', 2, { enabled: false });
    const cases: Array<[string, Record<string, unknown>]> = [
      ['provider=anthropic&profileId=o', { profileId: 'o', provider: 'openai', lane: 'cli' }],
      [
        'provider=anthropic&profileId=k',
        { profileId: 'k', provider: 'anthropic', lane: 'api-key' },
      ],
      ['provider=anthropic&lane=api-key&profileId=a', { profileId: 'a', lane: 'cli' }],
      ['provider=anthropic&profileId=off', { profileId: 'off' }],
    ];
    for (const [q, details] of cases) {
      const { res, body } = await pickById(q);
      expect(res.status, q).toBe(400);
      expect(body.iron, q).toMatchObject({ code: 'INVALID_REQUEST', details });
      expect(body.iron.hint, q).toBeTruthy();
    }
    expect((await pickById('provider=anthropic&profileId=off')).body.error.message).toContain(
      'disabled',
    );
  });

  it('a parked account is QUOTA_EXCEEDED (429) with resetAt, kind and retry-after, not another account', async () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    await put('a', 0);
    await put('b', 1, {
      status: 'parked',
      until,
      reason: { kind: 'quota-exhausted', source: 'cli-output', resetAt: until },
    });
    const { res, body } = await pickById('provider=anthropic&profileId=b');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(590);
    expect(body.profile).toBeUndefined();
    expect(body.error.code).toBe('QUOTA_EXCEEDED');
    expect(body.iron).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      retryable: true,
      details: {
        profileId: 'b',
        title: 'T b',
        provider: 'anthropic',
        resetAt: until,
        kind: 'quota-exhausted',
      },
    });
    expect(body.iron.hint).toContain('T b');
    expect((await h.iron.allStates()).b?.status).toBe('parked');
  });

  it('a park whose reset has passed is cleared and the account answered', async () => {
    await put('b', 1, { status: 'parked', until: new Date(Date.now() - 1_000).toISOString() });
    const { res, body } = await pickById('provider=anthropic&profileId=b');
    expect(res.status).toBe(200);
    expect(body.profile?.id).toBe('b');
    expect((await h.iron.allStates()).b?.status).toBe('ready');
  });

  it('an account that needs sign-in is AUTH_REQUIRED (401) naming it', async () => {
    await put('a', 0);
    await put('b', 1, { status: 'unauthenticated' });
    const { res, body } = await pickById('provider=anthropic&profileId=b');
    expect(res.status).toBe(401);
    expect(body.iron).toMatchObject({
      code: 'AUTH_REQUIRED',
      details: { profileId: 'b', title: 'T b' },
    });
    expect(body.iron.hint).toContain('iron-proxy login b');
  });

  it('an unknown id is PROFILE_NOT_FOUND (404); an empty one is a 400', async () => {
    await put('a', 0);
    const { res, body } = await pickById('provider=anthropic&profileId=nope');
    expect(res.status).toBe(404);
    expect(body.iron).toMatchObject({ code: 'PROFILE_NOT_FOUND', details: { profileId: 'nope' } });
    const empty = await pickById('provider=anthropic&profileId=');
    expect(empty.res.status).toBe(400);
    expect(empty.body.iron.code).toBe('INVALID_REQUEST');
  });
});

describe('GET /iron/pick?profileId=&pinned=1', () => {
  type Body = IronBody & {
    error?: { message: string; code: string };
    profile?: Profile;
    env?: unknown;
  };
  const pick = async (q: string) => {
    const res = await get(`/iron/pick?${q}`);
    return { res, text: await res.text() };
  };
  /** The answer with and without pinned=1: same status, same body, same retry-after. */
  const same = async (q: string) => {
    const plain = await pick(q);
    const pinned = await pick(`${q}&pinned=1`);
    expect(pinned.res.status, q).toBe(plain.res.status);
    expect(pinned.text, q).toBe(plain.text);
    expect(pinned.res.headers.get('retry-after') !== null, q).toBe(
      plain.res.headers.get('retry-after') !== null,
    );
    return { status: pinned.res.status, body: JSON.parse(pinned.text) as Body };
  };

  it('answers that usable account, never the one that comes first', async () => {
    await put('a', 0);
    await put('b', 1);
    const { status, body } = await same('provider=anthropic&profileId=b');
    expect(status).toBe(200);
    expect(body.profile?.id).toBe('b');
    expect(body).toMatchObject({ env: { set: { CLAUDE_CONFIG_DIR: join(h.dir, 'b') } } });
  });

  it('a parked account answers its park (QUOTA_EXCEEDED, resetAt, kind), never the next account', async () => {
    const until = new Date(Date.now() + 600_000).toISOString();
    await put('a', 0);
    await put('b', 1, {
      status: 'parked',
      until,
      reason: { kind: 'quota-exhausted', source: 'cli-output', resetAt: until },
    });
    const { status, body } = await same('provider=anthropic&profileId=b');
    expect(status).toBe(429);
    expect(body.profile).toBeUndefined();
    expect(body.iron).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { profileId: 'b', resetAt: until, kind: 'quota-exhausted' },
    });
  });

  it('sign-in, unknown, disabled and another provider answer exactly as a profileId pick', async () => {
    await put('a', 0);
    await put('u', 1, { status: 'unauthenticated' });
    await put('off', 2, { enabled: false });
    await put('o', 0, { provider: 'openai' });
    const cases: Array<[string, number, string]> = [
      ['provider=anthropic&profileId=u', 401, 'AUTH_REQUIRED'],
      ['provider=anthropic&profileId=nope', 404, 'PROFILE_NOT_FOUND'],
      ['provider=anthropic&profileId=off', 400, 'INVALID_REQUEST'],
      ['provider=anthropic&profileId=o', 400, 'INVALID_REQUEST'],
    ];
    for (const [q, status, code] of cases) {
      const r = await same(q);
      expect(r.status, q).toBe(status);
      expect(r.body.iron.code, q).toBe(code);
    }
  });

  it('pinned=1 without profileId is a 400, never the next ready account', async () => {
    await put('a', 0);
    for (const q of ['provider=anthropic&pinned=1', 'provider=anthropic&pinned=true']) {
      const res = await get(`/iron/pick?${q}`);
      expect(res.status, q).toBe(400);
      const body = (await res.json()) as Body;
      expect(body.profile, q).toBeUndefined();
      expect(body.iron.code, q).toBe('INVALID_REQUEST');
    }
    expect((await get('/iron/pick?provider=anthropic&pinned=1&profileId=')).status).toBe(400);
  });

  it('pinned=0 (or false) is the plain pick; any other value is a 400', async () => {
    await put('a', 0);
    await put('b', 1);
    const plain = await pick('provider=anthropic');
    for (const v of ['0', 'false']) {
      const r = await pick(`provider=anthropic&pinned=${v}`);
      expect(r.res.status, v).toBe(200);
      expect(r.text, v).toBe(plain.text);
    }
    for (const v of ['', 'yes', '2']) {
      const res = await get(`/iron/pick?provider=anthropic&profileId=b&pinned=${v}`);
      expect(res.status, v).toBe(400);
      expect(((await res.json()) as Body).iron.code, v).toBe('INVALID_REQUEST');
    }
  });
});

describe('plan and usage windows over HTTP', () => {
  it('finished with rateLimits / headers shows plan and windows in its state and GET /iron/states', async () => {
    await put('o', 0, { provider: 'openai' });
    await put('a', 1);
    const resets = Math.floor(Date.now() / 1000) + 86_400;
    const res = await post('/iron/profiles/o/finished', {
      usage: { inputTokens: 2, outputTokens: 1 },
      rateLimits: {
        planType: 'plus',
        primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: resets },
        secondary: { usedPercent: 38, windowDurationMins: 10_080, resetsAt: resets },
        credits: { hasCredits: true, unlimited: false, balance: '12' },
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; state: Record<string, unknown> };
    expect(body.state).toMatchObject({
      status: 'active',
      plan: 'plus',
      planSource: 'rate-limits',
      windows: [
        { kind: 'primary', usedPercent: 7, windowMins: 300, source: 'rate-limits' },
        { kind: 'secondary', usedPercent: 38, windowMins: 10_080, source: 'rate-limits' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('balance');
    const claude = await post('/iron/profiles/a/finished', {
      headers: {
        'anthropic-ratelimit-unified-7d-utilization': '0.25',
        'anthropic-ratelimit-unified-7d-reset': String(resets),
      },
    });
    expect(claude.status).toBe(200);
    const states = (await (await get('/iron/states')).json()) as Record<
      string,
      Record<string, unknown>
    >;
    expect(states.o).toMatchObject({
      plan: 'plus',
      windows: [{ kind: 'primary' }, { kind: 'secondary' }],
    });
    expect(states.a).toMatchObject({
      windows: [{ kind: '7d', usedPercent: 25, windowMins: 10_080 }],
    });
  });

  it('a non-object rateLimits is a 400 and records nothing', async () => {
    await put('o', 0, { provider: 'openai' });
    for (const rateLimits of ['plus', [1], 7]) {
      const res = await post('/iron/profiles/o/finished', { rateLimits });
      expect(res.status, JSON.stringify(rateLimits)).toBe(400);
      const sig = await post('/iron/profiles/o/signal', { text: 'limit reached', rateLimits });
      expect(sig.status, JSON.stringify(rateLimits)).toBe(400);
    }
    expect((await h.iron.allStates()).o).toMatchObject({ status: 'ready', served: 0 });
    // `rateLimits: null` is no snapshot: the report counts.
    const ok = await post('/iron/profiles/o/finished', { rateLimits: null });
    expect(ok.status).toBe(200);
    expect((await h.iron.allStates()).o).toMatchObject({ status: 'active', served: 1 });
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

    await put('b', 1);
    const byId = await client.pick('anthropic', { profileId: 'b' });
    expect(byId.profile.id).toBe('b');
    expect(byId.env?.set.CLAUDE_CONFIG_DIR).toBe(join(h.dir, 'b'));
    const e3 = (await client
      .pick('anthropic', { profileId: 'a' })
      .catch((x: unknown) => x)) as HttpIronClientError;
    expect(e3).toMatchObject({ status: 429, code: 'QUOTA_EXCEEDED' });
    expect(typeof e3.details.resetAt).toBe('string');
    await expect(client.pick('anthropic', { profileId: 'zz' })).rejects.toMatchObject({
      status: 404,
      code: 'PROFILE_NOT_FOUND',
    });
    await expect(client.pick('anthropic', { profileId: '' })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });

    // pinned: that account, its park, or a 400 when no account is named.
    expect((await client.pick('anthropic', { profileId: 'b', pinned: true })).profile.id).toBe('b');
    await expect(client.pick('anthropic', { profileId: 'a', pinned: true })).rejects.toMatchObject({
      status: 429,
      code: 'QUOTA_EXCEEDED',
    });
    await expect(client.pick('anthropic', { pinned: true })).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
    });
  });
});
