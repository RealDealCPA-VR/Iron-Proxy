import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSpec,
  CliLane,
  codexSpec,
  createDefaultRegistry,
  createIronProxy,
  grokSpec,
  type DiscoveredLogin,
  type IronProxy,
} from '@iron-proxy/core';
import { runCli, type CliIo } from '../src/index.js';

const FAKE = fileURLToPath(
  new URL('../../core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url),
);

let dir: string;
let user: string;
let iron: IronProxy;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-cli-adopt-'));
  user = join(dir, 'user');
  await mkdir(join(user, '.claude'), { recursive: true });
  await writeFile(join(user, '.claude', 'logged-in'), 'yes');
  await writeFile(join(user, '.claude', 'keep.txt'), 'mine');
  await mkdir(join(user, '.codex'), { recursive: true }); // present, signed out
  iron = createIronProxy({
    dataDir: join(dir, 'data'),
    registry: createDefaultRegistry()
      .addLane('anthropic', new CliLane({ ...claudeSpec, binary: FAKE }))
      .addLane('openai', new CliLane({ ...codexSpec, binary: FAKE }))
      .addLane('xai', new CliLane({ ...grokSpec, binary: FAKE })),
    env: { HOME: user, USERPROFILE: user },
  });
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

function io() {
  let out = '';
  let err = '';
  const o: CliIo = {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    iron,
    env: { IRON_PROXY_DATA_DIR: join(dir, 'data') },
  };
  return { io: o, out: () => out, err: () => err };
}

describe('profiles discover / adopt', () => {
  it('lists existing logins, adopts the default one, and refuses it twice with a hint', async () => {
    const d = io();
    expect(await runCli(['profiles', 'discover'], d.io)).toBe(0);
    const lines = d.out().trim().split('\n');
    expect(lines[0]).toMatch(/^provider\s+home\s+installed\s+signed in\s+already adopted$/);
    expect(lines.find((l) => l.startsWith('anthropic'))).toMatch(/yes\s+yes\s+no$/);
    expect(lines.find((l) => l.startsWith('openai'))).toMatch(/yes\s+no\s+no$/);

    const a = io();
    expect(await runCli(['profiles', 'adopt', 'anthropic', '--title', 'My Claude'], a.io)).toBe(0);
    expect(a.out()).toContain(resolve(user, '.claude'));
    expect(a.out()).toContain('"My Claude", ready');
    const [p] = await iron.listProfiles();
    expect(p?.cli).toEqual({ home: resolve(user, '.claude'), adopted: true });

    const j = io();
    expect(await runCli(['profiles', 'discover', '--json'], j.io)).toBe(0);
    const found = JSON.parse(j.out()) as DiscoveredLogin[];
    expect(found.find((f) => f.provider === 'anthropic')?.adoptedProfileId).toBe(p!.id);

    const again = io();
    expect(await runCli(['profiles', 'adopt', 'anthropic'], again.io)).toBe(1);
    expect(again.err()).toMatch(/^INVALID_REQUEST: Profile "My Claude" already uses/);
    expect(again.err()).toMatch(new RegExp(`\\nhint: Use the existing profile ${p!.id}`));

    const none = io();
    expect(await runCli(['profiles', 'adopt', 'xai'], none.io)).toBe(1);
    expect(none.err()).toContain('hint: Run iron-proxy profiles discover');

    // --home adopts a directory that is not the default; logging it out warns.
    const other = join(dir, 'elsewhere');
    await mkdir(other);
    const h = io();
    expect(await runCli(['profiles', 'adopt', 'xai', '--home', other], h.io)).toBe(0);
    const grok = (await iron.listProfiles('xai'))[0]!;
    const lo = io();
    expect(await runCli(['logout', grok.id], lo.io)).toBe(0);
    expect(lo.err()).toContain('was an existing login');

    // Removing the adopted profile keeps the user's own files.
    expect(await runCli(['profiles', 'remove', p!.id], io().io)).toBe(0);
    expect(await readFile(join(user, '.claude', 'keep.txt'), 'utf8')).toBe('mine');
  });
});

describe('profiles adopt <provider> without --home', () => {
  it("looks only at that provider's default home and runs no other vendor CLI", async () => {
    const a = io();
    expect(await runCli(['profiles', 'adopt', 'anthropic'], a.io)).toBe(0);
    expect((await iron.listProfiles())[0]?.cli).toEqual({
      home: resolve(user, '.claude'),
      adopted: true,
    });
    // The fake CLI records every run in the home it was given: codex was never started.
    await expect(stat(join(user, '.codex', 'last-invocation.json'))).rejects.toThrow();
  });

  it("fails clearly when that provider's default home does not exist", async () => {
    const r = io();
    expect(await runCli(['profiles', 'adopt', 'xai'], r.io)).toBe(1);
    expect(r.err()).toContain(
      `INVALID_REQUEST: No existing xai CLI login found in its default location (${resolve(user, '.grok')}).`,
    );
    expect(r.err()).toContain('\nhint: Run iron-proxy profiles discover');
    expect(await iron.listProfiles()).toEqual([]);
    // Gemini is never adopted from a default home.
    const g = io();
    expect(await runCli(['profiles', 'adopt', 'google'], g.io)).toBe(1);
    expect(g.err()).toContain('No existing google CLI login found in its default location.');
  });
});

describe('hints', () => {
  it('prints the hint on its own line after the error', async () => {
    const r = io();
    expect(await runCli(['profiles', 'remove', 'nope'], r.io)).toBe(1);
    expect(r.err()).toBe(
      'PROFILE_NOT_FOUND: Profile "nope" does not exist.\nhint: Run iron-proxy profiles list (or open the switcher) and use one of the ids shown there.\n',
    );

    const c = io();
    expect(await runCli(['chat', 'google', 'hi'], c.io)).toBe(1);
    expect(c.err()).toContain('NO_PROFILE');
    expect(c.err()).toContain(
      '\nhint: Add an account for google: iron-proxy profiles add --provider google --lane cli --title',
    );
  });
});
