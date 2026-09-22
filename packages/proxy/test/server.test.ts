import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, readSse, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
  await rm(h.dir, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${h.token}` });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${h.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function twoAnthropic() {
  const a = await h.iron.createProfile({
    title: 'A',
    provider: 'anthropic',
    lane: 'api-key',
    apiKeySecret: 'key-A',
    defaultModel: 'claude-x',
  });
  const b = await h.iron.createProfile({
    title: 'B',
    provider: 'anthropic',
    lane: 'api-key',
    apiKeySecret: 'key-B',
  });
  return { a, b };
}

describe('control API auth', () => {
  it('rejects control routes without or with a wrong token, allows health', async () => {
    expect((await fetch(`${h.url}/iron/profiles`)).status).toBe(401);
    expect(
      (await fetch(`${h.url}/iron/profiles`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    expect(
      (await fetch(`${h.url}/iron/profiles`, { headers: { 'x-iron-token': h.token } })).status,
    ).toBe(200);
    const health = await fetch(`${h.url}/iron/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
  });

  it('model routes work without a token by default, and require one when configured', async () => {
    await twoAnthropic();
    const res = await post('/v1/chat/completions', {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    await h.close();
    h = await harness({ requireAuthForModels: true });
    await twoAnthropic();
    expect(
      (
        await post('/v1/chat/completions', {
          model: 'claude-x',
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          '/v1/chat/completions',
          { model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] },
          auth(),
        )
      ).status,
    ).toBe(200);
  });

  it('returns 404 for unknown routes in the dialect shape and 413 for big bodies', async () => {
    const r = await fetch(`${h.url}/v1/nope`, { method: 'POST' });
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({
      error: { message: expect.stringContaining('No route') },
      iron: { code: 'INVALID_REQUEST' },
    });
    await h.close();
    h = await harness();
    h.proxy.server.maxHeadersCount = 100;
    const big = 'x'.repeat(21 * 1024 * 1024);
    const r2 = await post('/v1/chat/completions', {
      model: 'claude-x',
      messages: [{ role: 'user', content: big }],
    }).catch(() => undefined);
    if (r2) expect(r2.status).toBe(413);
  });
});

describe('/v1/chat/completions', () => {
  it('fails over from A to B and names the serving profile in a header', async () => {
    const { b } = await twoAnthropic();
    h.upstream.exhaustNext.add('key-A');
    const res = await post('/v1/chat/completions', {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-iron-profile')).toBe(b.id);
    const json = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number };
    };
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0]?.message.content).toBe('served by key-B');
    expect(json.usage.prompt_tokens).toBe(3);
    expect(h.upstream.calls.map((c) => c.key)).toEqual(['key-A', 'key-B']);
  });

  it('streams OpenAI chunks with the switched comment and [DONE]', async () => {
    const { a, b } = await twoAnthropic();
    h.upstream.exhaustNext.add('key-A');
    const res = await post('/v1/chat/completions', {
      model: 'claude-x',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const { comments, frames } = await readSse(res);
    expect(comments).toContain(`iron switched ${a.id} -> ${b.id}`);
    expect(comments).toContain(`iron profile ${b.id}`);
    expect(frames.at(-1)?.data).toBe('[DONE]');
    const chunks = frames.slice(0, -1).map(
      (f) =>
        JSON.parse(f.data) as {
          object: string;
          choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
        },
    );
    for (const c of chunks) expect(c.object).toBe('chat.completion.chunk');
    const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
    expect(text).toBe('served by key-B');
    expect(chunks.some((c) => c.choices[0]?.finish_reason === 'stop')).toBe(true);
  });

  it('answers 429 with retry-after when every account is parked, in OpenAI error shape', async () => {
    await twoAnthropic();
    const reset = new Date(Date.now() + 90_000).toISOString();
    h.upstream.alwaysExhausted.set('key-A', reset);
    h.upstream.alwaysExhausted.set('key-B', reset);
    const res = await post('/v1/chat/completions', {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(429);
    const ra = Number(res.headers.get('retry-after'));
    expect(ra).toBeGreaterThan(60);
    expect(ra).toBeLessThanOrEqual(90);
    const body = (await res.json()) as {
      error: { type: string };
      iron: { code: string; retryable: boolean };
    };
    expect(body.error.type).toBe('all_profiles_exhausted');
    expect(body.iron).toMatchObject({ code: 'ALL_PROFILES_EXHAUSTED', retryable: true });
    // streaming variant fails before headers are sent, so it is a real 429 too
    for (const p of await h.iron.listProfiles()) await h.iron.unpark(p.id);
    const s = await post('/v1/chat/completions', {
      model: 'claude-x',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(s.status).toBe(429);
  });

  it('routes by x-iron-provider / x-iron-profile and reports unknown providers and missing profiles', async () => {
    const { b } = await twoAnthropic();
    await h.iron.createProfile({
      title: 'O',
      provider: 'openai',
      lane: 'api-key',
      apiKeySecret: 'key-O',
    });
    const byHeader = await post(
      '/v1/chat/completions',
      { model: 'whatever', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-iron-provider': 'openai' },
    );
    expect(byHeader.status).toBe(200);
    expect(
      ((await byHeader.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]
        ?.message.content,
    ).toBe('served by key-O');
    const pinned = await post(
      '/v1/chat/completions',
      { model: 'whatever', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-iron-profile': b.id },
    );
    expect(pinned.headers.get('x-iron-profile')).toBe(b.id);
    expect(
      (
        await post(
          '/v1/chat/completions',
          { model: 'x', messages: [] },
          { 'x-iron-provider': 'nope' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          '/v1/chat/completions',
          { model: 'x', messages: [] },
          { 'x-iron-profile': 'missing' },
        )
      ).status,
    ).toBe(404);
    const ambiguous = await post('/v1/chat/completions', {
      model: 'mystery',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(ambiguous.status).toBe(400);
    expect(((await ambiguous.json()) as { iron: { code: string } }).iron.code).toBe(
      'INVALID_REQUEST',
    );
    const none = await post('/v1/chat/completions', {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(none.status).toBe(404);
  });

  it('rejects a body without messages or invalid JSON', async () => {
    expect((await post('/v1/chat/completions', { model: 'claude-x' })).status).toBe(400);
    const bad = await fetch(`${h.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
  });
});

describe('/v1/messages', () => {
  it('returns an Anthropic-shaped message and requires model + max_tokens', async () => {
    const { a } = await twoAnthropic();
    const res = await post('/v1/messages', {
      model: 'claude-x',
      max_tokens: 50,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-iron-profile')).toBe(a.id);
    const body = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { output_tokens: number };
    };
    expect(body).toMatchObject({ type: 'message', role: 'assistant', stop_reason: 'end_turn' });
    expect(body.content[0]?.text).toBe('served by key-A');
    expect(body.usage.output_tokens).toBe(2);
    expect((await post('/v1/messages', { model: 'claude-x', messages: [] })).status).toBe(400);
    expect((await post('/v1/messages', { max_tokens: 5, messages: [] })).status).toBe(400);
  });

  it('streams Anthropic events with event names, and the switched comment', async () => {
    const { a, b } = await twoAnthropic();
    h.upstream.exhaustNext.add('key-A');
    const res = await post('/v1/messages', {
      model: 'claude-x',
      max_tokens: 50,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    const { comments, frames } = await readSse(res);
    expect(comments).toContain(`iron switched ${a.id} -> ${b.id}`);
    expect(frames.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    for (const f of frames) expect((JSON.parse(f.data) as { type: string }).type).toBe(f.event);
    const text = frames
      .filter((f) => f.event === 'content_block_delta')
      .map((f) => (JSON.parse(f.data) as { delta: { text: string } }).delta.text)
      .join('');
    expect(text).toBe('served by key-B');
  });

  it('formats errors in the Anthropic shape', async () => {
    const res = await post('/v1/messages', {
      model: 'claude-x',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      type: 'error',
      error: { type: 'no_profile' },
      iron: { code: 'NO_PROFILE' },
    });
  });
});

describe('/v1/models and control routes', () => {
  it('lists models from profiles and adapters', async () => {
    await twoAnthropic();
    const res = await fetch(`${h.url}/v1/models`);
    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string; owned_by: string }>;
    };
    expect(body.object).toBe('list');
    expect(body.data.find((m) => m.id === 'claude-x')?.owned_by).toBe('anthropic');
    expect(body.data.some((m) => m.owned_by === 'openai')).toBe(true);
  });

  it('CRUD + reorder + activate + unpark + states + providers + doctor + refresh', async () => {
    const created = await post(
      '/iron/profiles',
      { title: 'A', provider: 'anthropic', lane: 'api-key', apiKeySecret: 'key-A' },
      auth(),
    );
    expect(created.status).toBe(201);
    const a = (await created.json()) as { id: string; order: number };
    const b = (await (
      await post(
        '/iron/profiles',
        { title: 'B', provider: 'anthropic', lane: 'api-key', apiKeySecret: 'key-B' },
        auth(),
      )
    ).json()) as { id: string };
    expect(await h.iron.vault.get(`apikey:${a.id}`)).toBe('key-A');

    const patched = await fetch(`${h.url}/iron/profiles/${a.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth() },
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(((await patched.json()) as { title: string }).title).toBe('Renamed');
    expect(
      (await (await fetch(`${h.url}/iron/profiles/${a.id}`, { headers: auth() })).json()) as object,
    ).toMatchObject({ title: 'Renamed' });

    const reordered = (await (
      await post('/iron/profiles/reorder', { provider: 'anthropic', ids: [b.id, a.id] }, auth())
    ).json()) as Array<{ id: string }>;
    expect(reordered.map((p) => p.id)).toEqual([b.id, a.id]);
    const activated = (await (
      await post(`/iron/profiles/${a.id}/activate`, {}, auth())
    ).json()) as { order: number };
    expect(activated.order).toBe(0);

    expect(
      (await post(`/iron/profiles/${a.id}/api-key`, { secret: 'key-A2' }, auth())).status,
    ).toBe(200);
    expect(await h.iron.vault.get(`apikey:${a.id}`)).toBe('key-A2');
    expect((await post(`/iron/profiles/${a.id}/api-key`, {}, auth())).status).toBe(400);

    const states = (await (
      await fetch(`${h.url}/iron/states`, { headers: auth() })
    ).json()) as Record<string, { status: string }>;
    expect(Object.keys(states).sort()).toEqual([a.id, b.id].sort());
    const providers = (await (
      await fetch(`${h.url}/iron/providers`, { headers: auth() })
    ).json()) as Array<{ id: string; lanes: string[] }>;
    expect(providers.find((p) => p.id === 'anthropic')?.lanes.sort()).toEqual(['api-key', 'cli']);
    const doctor = (await (
      await fetch(`${h.url}/iron/doctor`, { headers: auth() })
    ).json()) as Array<{ binary: string }>;
    expect(doctor.map((d) => d.binary).sort()).toEqual(['claude', 'codex', 'gemini', 'grok']);
    const refreshed = (await (await post('/iron/refresh', { id: a.id }, auth())).json()) as Array<{
      profileId: string;
    }>;
    expect(refreshed[0]?.profileId).toBe(a.id);
    expect((await post(`/iron/profiles/${a.id}/unpark`, {}, auth())).status).toBe(200);
    expect((await fetch(`${h.url}/iron/profiles/${a.id}/models`, { headers: auth() })).status).toBe(
      200,
    );
    expect((await post(`/iron/profiles/${a.id}/logout`, {}, auth())).status).toBe(200);
    // logout removed the key, so listing models now needs auth again
    expect((await fetch(`${h.url}/iron/profiles/${a.id}/models`, { headers: auth() })).status).toBe(
      401,
    );
    expect(
      (await fetch(`${h.url}/iron/profiles/${a.id}/login-command`, { headers: auth() })).status,
    ).toBe(400);

    expect(
      (await fetch(`${h.url}/iron/profiles/${a.id}`, { method: 'DELETE', headers: auth() })).status,
    ).toBe(200);
    expect((await fetch(`${h.url}/iron/profiles/${a.id}`, { headers: auth() })).status).toBe(404);
    expect((await fetch(`${h.url}/iron/nope`, { headers: auth() })).status).toBe(404);
    expect(
      (await post('/iron/profiles', { title: '', provider: 'anthropic', lane: 'api-key' }, auth()))
        .status,
    ).toBe(400);
  });

  it('login returns 202 and completion arrives through /iron/events; unsupported logins are 400', async () => {
    const fake = new URL('../../core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url);
    const { fileURLToPath } = await import('node:url');
    const p = await h.iron.createProfile({
      title: 'Claude Max',
      provider: 'anthropic',
      lane: 'cli',
      cli: { binary: fileURLToPath(fake), env: { FAKE_CLI_FLAVOR: 'claude' } } as never,
    });

    const controller = new AbortController();
    const evRes = await fetch(`${h.url}/iron/events`, {
      headers: auth(),
      signal: controller.signal,
    });
    expect(evRes.status).toBe(200);
    const reader = evRes.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const waitFor = async (pred: (s: string) => boolean) => {
      while (!pred(buf)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    };

    const started = await post(`/iron/profiles/${p.id}/login`, {}, auth());
    expect(started.status).toBe(202);
    await waitFor((s) => s.includes('"type":"completed"'));
    expect(buf).toContain('event: login');
    expect(buf).toContain('https://example.test/device');

    // a park shows up on the stream too
    const a = await h.iron.createProfile({
      title: 'A',
      provider: 'openai',
      lane: 'api-key',
      apiKeySecret: 'key-A',
    });
    await h.iron.createProfile({
      title: 'B',
      provider: 'openai',
      lane: 'api-key',
      apiKeySecret: 'key-B',
    });
    h.upstream.exhaustNext.add('key-A');
    await post('/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await waitFor((s) => s.includes('event: profile.parked'));
    expect(buf).toContain(`"profileId":"${a.id}"`);
    controller.abort();

    const g = await h.iron.createProfile({ title: 'Gem', provider: 'google', lane: 'cli' });
    expect((await post(`/iron/profiles/${g.id}/login`, {}, auth())).status).toBe(400);
    expect((await post(`/iron/profiles/${g.id}/login/cancel`, {}, auth())).status).toBe(200);
  });

  it('CORS headers and preflight when enabled', async () => {
    await h.close();
    h = await harness({ cors: true });
    const pre = await fetch(`${h.url}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const health = await fetch(`${h.url}/iron/health`, { headers: { origin: 'http://x' } });
    expect(health.headers.get('access-control-allow-origin')).toBe('http://x');
  });
});
