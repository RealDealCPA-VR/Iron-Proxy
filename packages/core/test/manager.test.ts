import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIronProxy, type IronProxy } from '../src/manager.js';
import type { IronEvent } from '../src/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli/fake-cli.mjs', import.meta.url));

let dir: string;
let iron: IronProxy;
const events: IronEvent[] = [];

/** Fake fetch for API-key profiles: first call 429s with reset headers, later ones succeed. */
function fakeAnthropicFetch(): {
  fetch: typeof fetch;
  calls: Array<{ url: string; key: string | null }>;
} {
  const calls: Array<{ url: string; key: string | null }> = [];
  let n = 0;
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit);
    const key = headers.get('x-api-key');
    calls.push({ url, key });
    n++;
    if (key === 'key-A' && n === 1) {
      return new Response(
        '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
        {
          status: 429,
          headers: {
            'anthropic-ratelimit-requests-reset': new Date(Date.now() + 3_600_000).toISOString(),
            'content-type': 'application/json',
          },
        },
      );
    }
    const body = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content: [{ type: 'text', text: `served by ${key}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'anthropic-ratelimit-requests-limit': '100',
        'anthropic-ratelimit-requests-remaining': '90',
      },
    });
  };
  return { fetch: f, calls };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-mgr-'));
  events.length = 0;
});
afterEach(async () => {
  await iron?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('IronProxy manager', () => {
  it('creates, titles, reorders, activates and deletes profiles', async () => {
    iron = createIronProxy({ dataDir: dir });
    iron.events.onAny((e) => events.push(e));
    const a = await iron.createProfile({
      title: ' Work Claude ',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-A',
    });
    const b = await iron.createProfile({
      title: 'Personal Claude',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-B',
    });
    expect(a.title).toBe('Work Claude');
    expect([a.order, b.order]).toEqual([0, 1]);
    expect(await iron.vault.get(a.apiKey!.secretRef)).toBe('key-A');

    await iron.updateProfile(b.id, { title: 'Home Claude' });
    expect((await iron.getProfile(b.id)).title).toBe('Home Claude');

    await iron.activate(b.id);
    const ordered = await iron.listProfiles('anthropic');
    expect(ordered.map((p) => p.id)).toEqual([b.id, a.id]);

    await iron.deleteProfile(a.id);
    expect(await iron.vault.has(a.apiKey!.secretRef)).toBe(false);
    expect((await iron.listProfiles()).map((p) => p.id)).toEqual([b.id]);
    expect(events.filter((e) => e.type === 'profile.created')).toHaveLength(2);
    expect(events.find((e) => e.type === 'profile.deleted')).toBeDefined();
  });

  it('validates input', async () => {
    iron = createIronProxy({ dataDir: dir });
    await expect(
      iron.createProfile({ title: '', provider: 'anthropic', lane: 'api-key' }),
    ).rejects.toThrow(/title/);
    await expect(
      iron.createProfile({ title: 'x', provider: 'openai-compatible', lane: 'api-key' }),
    ).rejects.toThrow(/baseUrl/);
    await expect(
      iron.createProfile({ title: 'x', provider: 'openai-compatible', lane: 'cli' }),
    ).rejects.toThrow(/no "cli" lane/);
    await expect(
      iron.createProfile({ title: 'x', provider: 'anthropic', lane: 'oauth' }),
    ).rejects.toThrow(/oauth.extension/);
    await expect(iron.getProfile('nope')).rejects.toThrow(/does not exist/);
  });

  it('fails over between two API-key accounts of the same provider, end to end', async () => {
    const { fetch: f, calls } = fakeAnthropicFetch();
    iron = createIronProxy({ dataDir: dir, fetch: f });
    iron.events.onAny((e) => events.push(e));
    const a = await iron.createProfile({
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-A',
    });
    const b = await iron.createProfile({
      title: 'B',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-B',
    });

    const res = await iron.complete({
      model: 'claude-x',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(res.profileId).toBe(b.id);
    expect(res.message.content[0]).toEqual({ type: 'text', text: 'served by key-B' });
    expect(calls.map((c) => c.key)).toEqual(['key-A', 'key-B']);

    const states = await iron.allStates();
    expect(states[a.id]?.status).toBe('parked');
    expect(states[b.id]?.status).toBe('active');
    expect(states[b.id]?.usage?.requestsRemaining).toBe(90);
    expect(iron.activeProfileId('anthropic')).toBe(b.id);
    expect(events.some((e) => e.type === 'profile.switched' && e.toProfileId === b.id)).toBe(true);
  });

  it('creates an isolated CLI home per subscription profile, logs in and answers through it', async () => {
    iron = createIronProxy({ dataDir: dir });
    iron.events.onAny((e) => events.push(e));
    const p = await iron.createProfile({
      title: 'Claude Max',
      provider: 'anthropic',
      lane: 'cli',
      cli: { binary: FAKE, env: { FAKE_CLI_FLAVOR: 'claude' } } as never,
    });
    expect(p.cli?.home).toBe(join(dir, 'cli-homes', 'anthropic', p.id));
    expect((await stat(p.cli!.home)).isDirectory()).toBe(true);

    const cmd = await iron.loginCommand(p.id);
    expect(cmd.env.CLAUDE_CONFIG_DIR).toBe(p.cli!.home);

    const session = await iron.login(p.id);
    await session.done;
    expect(events.some((e) => e.type === 'login' && e.event.type === 'url')).toBe(true);
    const [st] = await iron.refreshStatus(p.id);
    expect(st?.status).toBe('ready');

    const res = await iron.complete({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    });
    expect(res.message.content[0]).toEqual({ type: 'text', text: 'echo:ping' });

    await iron.logout(p.id);
    expect((await iron.allStates())[p.id]?.status).toBe('unauthenticated');
    await iron.deleteProfile(p.id);
    await expect(stat(p.cli!.home)).rejects.toThrow();
  });

  it('doctor reports the vendor CLIs', async () => {
    iron = createIronProxy({ dataDir: dir });
    const probes = await iron.doctor();
    expect(probes.map((p) => p.binary).sort()).toEqual(['claude', 'codex', 'gemini', 'grok']);
    for (const p of probes) expect(typeof p.found).toBe('boolean');
  });
});
