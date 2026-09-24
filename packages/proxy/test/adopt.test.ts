import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSpec,
  CliLane,
  codexSpec,
  createDefaultRegistry,
  grokSpec,
  type DiscoveredLogin,
} from '@iron-proxy/core';
import { HttpIronClient, HttpIronClientError } from '../src/client.js';
import { harness, type Harness } from './helpers.js';

const FAKE = fileURLToPath(
  new URL('../../core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url),
);

let h: Harness;
let user: string;
beforeEach(async () => {
  user = await mkdtemp(join(tmpdir(), 'iron-proxy-user-'));
  await mkdir(join(user, '.claude'), { recursive: true });
  await writeFile(join(user, '.claude', 'logged-in'), 'yes');
  await writeFile(join(user, '.claude', 'keep.txt'), 'mine');
  h = await harness({
    ironOpts: {
      registry: createDefaultRegistry()
        .addLane('anthropic', new CliLane({ ...claudeSpec, binary: FAKE }))
        .addLane('openai', new CliLane({ ...codexSpec, binary: FAKE }))
        .addLane('xai', new CliLane({ ...grokSpec, binary: FAKE })),
      env: { HOME: user, USERPROFILE: user },
    },
  });
});
afterEach(async () => {
  await h.close();
  await rm(h.dir, { recursive: true, force: true });
  await rm(user, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${h.token}` });

describe('existing logins over the control API', () => {
  it('GET /iron/discover and POST /iron/adopt, refusing a duplicate with a hint', async () => {
    expect((await fetch(`${h.url}/iron/discover`)).status).toBe(401);
    const res = await fetch(`${h.url}/iron/discover`, { headers: auth() });
    expect(res.status).toBe(200);
    const found = (await res.json()) as DiscoveredLogin[];
    expect(found).toEqual([
      {
        provider: 'anthropic',
        binary: FAKE,
        home: resolve(user, '.claude'),
        installed: true,
        status: 'ok',
        suggestedTitle: 'Claude (existing login)',
      },
    ]);

    const adopt = (body: unknown) =>
      fetch(`${h.url}/iron/adopt`, {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const created = await adopt({ provider: 'anthropic', home: found[0]!.home });
    expect(created.status).toBe(201);
    const p = (await created.json()) as { id: string; title: string; cli: { adopted: boolean } };
    expect(p.title).toBe('Claude (existing login)');
    expect(p.cli.adopted).toBe(true);

    const dup = await adopt({ provider: 'anthropic', home: found[0]!.home });
    expect(dup.status).toBe(400);
    const body = (await dup.json()) as { error: { message: string }; iron: { hint?: string } };
    expect(body.error.message).toContain('already uses');
    expect(body.iron.hint).toContain(p.id);

    expect((await adopt({ provider: 'anthropic' })).status).toBe(400);

    // Removing the adopted profile leaves the user's own CLI home alone.
    const del = await fetch(`${h.url}/iron/profiles/${p.id}`, {
      method: 'DELETE',
      headers: auth(),
    });
    expect(del.status).toBe(200);
    expect(await readFile(join(user, '.claude', 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('HttpIronClient.discoverLogins / adoptLogin, and errors carry the hint', async () => {
    const client = new HttpIronClient(h.url, h.token);
    const [found] = await client.discoverLogins();
    expect(found?.status).toBe('ok');
    const p = await client.adoptLogin({ provider: 'anthropic', home: found!.home, title: 'Mine' });
    expect(p.title).toBe('Mine');
    expect((await client.discoverLogins())[0]?.adoptedProfileId).toBe(p.id);
    const err = await client
      .adoptLogin({ provider: 'anthropic', home: found!.home })
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpIronClientError);
    expect(err.code).toBe('INVALID_REQUEST');
    expect(err.hint).toContain(p.id);
    const missing = await client.updateProfile('missing', { title: 'x' }).catch((e) => e);
    expect(missing.hint).toMatch(/iron-proxy profiles list/);
  });
});

describe('error bodies carry the hint', () => {
  it('in the OpenAI, Anthropic and JSON shapes', async () => {
    const openai = await fetch(`${h.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const ob = (await openai.json()) as { iron: { code: string; hint: string } };
    expect(ob.iron.code).toBe('NO_PROFILE');
    expect(ob.iron.hint).toContain('iron-proxy profiles add --provider openai');

    const anthropic = await fetch(`${h.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-x',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const ab = (await anthropic.json()) as { type: string; iron: { hint: string } };
    expect(ab.type).toBe('error');
    expect(ab.iron.hint).toContain('Add an account for anthropic:');

    const json = await fetch(`${h.url}/iron/profiles/missing/activate`, {
      method: 'POST',
      headers: auth(),
    });
    const jb = (await json.json()) as { iron: { code: string; hint: string } };
    expect(jb.iron.code).toBe('PROFILE_NOT_FOUND');
    expect(jb.iron.hint).toMatch(/iron-proxy profiles list/);
  });
});
