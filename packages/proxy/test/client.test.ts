import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IronEvent } from '@iron-proxy/core';
import { HttpIronClient, HttpIronClientError } from '../src/client.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
  await rm(h.dir, { recursive: true, force: true });
});

const waitFor = async (pred: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('HttpIronClient', () => {
  it('round-trips profiles, states, activate, delete and receives events', async () => {
    const client = new HttpIronClient(h.url, h.token);
    const events: IronEvent[] = [];
    const off = client.onEvent((e) => events.push(e));

    const providers = await client.providers();
    expect(providers.map((p) => p.id)).toContain('anthropic');

    const a = await client.createProfile({
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-A',
    });
    const b = await client.createProfile({
      title: 'B',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'key-B',
    });
    expect((await client.listProfiles()).map((p) => p.id)).toEqual([a.id, b.id]);

    const renamed = await client.updateProfile(a.id, { title: 'A2' });
    expect(renamed.title).toBe('A2');
    expect((await client.reorder('anthropic', [b.id, a.id])).map((p) => p.id)).toEqual([
      b.id,
      a.id,
    ]);
    expect((await client.activate(a.id)).order).toBe(0);
    await client.setApiKey(a.id, 'key-A2');
    expect(await h.iron.vault.get(a.apiKey!.secretRef)).toBe('key-A2');

    const states = await client.states();
    expect(Object.keys(states).sort()).toEqual([a.id, b.id].sort());
    expect((await client.refreshStatus(a.id))[0]?.profileId).toBe(a.id);
    expect(await client.listModels(a.id)).toEqual([]);
    expect((await client.doctor()).length).toBe(4);
    await client.unpark(a.id);
    await client.logout(b.id);

    await waitFor(() => events.some((e) => e.type === 'profile.created'));
    await client.deleteProfile(b.id);
    await waitFor(() => events.some((e) => e.type === 'profile.deleted'));
    expect((await client.listProfiles()).map((p) => p.id)).toEqual([a.id]);
    off();
  });

  it('surfaces server errors as HttpIronClientError with the iron code', async () => {
    const client = new HttpIronClient(h.url, h.token);
    const err = await client.updateProfile('missing', { title: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpIronClientError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('PROFILE_NOT_FOUND');
    const bad = new HttpIronClient(h.url, 'wrong');
    await expect(bad.listProfiles()).rejects.toMatchObject({ status: 401 });
  });

  it('login resolves on the completed event and loginCommand is exposed', async () => {
    const client = new HttpIronClient(h.url, h.token);
    const fake = fileURLToPath(
      new URL('../../core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url),
    );
    const p = await client.createProfile({
      title: 'Claude Max',
      provider: 'anthropic',
      lane: 'cli',
      cli: { binary: fake, env: { FAKE_CLI_FLAVOR: 'claude' } } as never,
    });
    const cmd = await client.loginCommand(p.id);
    expect(cmd.env.CLAUDE_CONFIG_DIR).toBe(p.cli!.home);
    expect(cmd.requiresTerminal).toBe(false);
    const seen: string[] = [];
    const off = client.onEvent((e) => {
      if (e.type === 'login') seen.push(e.event.type);
    });
    await client.login(p.id);
    off();
    expect(seen).toContain('url');
    expect(seen).toContain('completed');
    expect((await client.states())[p.id]?.status).toBe('ready');
  });

  it('cancelLogin does not throw for idle profiles', async () => {
    const client = new HttpIronClient(h.url, h.token);
    const a = await client.createProfile({
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'k',
    });
    await expect(client.cancelLogin(a.id)).resolves.toBeUndefined();
  });
});
