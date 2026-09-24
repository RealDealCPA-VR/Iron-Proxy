import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSpec,
  CliLane,
  codexSpec,
  createDefaultRegistry,
  createIronProxy,
  type IronProxy,
  type Profile,
} from '@iron-proxy/core';
import { runCli, type CliIo, type SpawnFn } from '../src/index.js';

const FAKE = fileURLToPath(
  new URL('../../core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url),
);

let dir: string;
let iron: IronProxy;
let savedKey: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-cli-run-'));
  iron = createIronProxy({
    dataDir: join(dir, 'data'),
    registry: createDefaultRegistry()
      .addLane('anthropic', new CliLane({ ...claudeSpec, binary: FAKE }))
      .addLane('openai', new CliLane({ ...codexSpec, binary: FAKE })),
  });
  // An API key in the parent environment must never reach the vendor CLI.
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-parent-env-should-not-leak';
});
afterEach(async () => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  await iron.close();
  // A background status check may still hold a home open on Windows for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A signed-in cli account whose home already holds the fake CLI's login marker. */
async function account(title: string, extra: Partial<Profile['cli']> = {}): Promise<Profile> {
  const home = join(dir, 'homes', title.replace(/[^\w']/g, '_')); // keeps ' to test quoting
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'logged-in'), 'yes');
  const p = await iron.createProfile({
    title,
    provider: 'anthropic',
    lane: 'cli',
    cli: { home, ...extra },
  });
  await iron.refreshStatus(p.id);
  return p;
}

interface Spawned {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

function io(extra: Partial<CliIo> = {}) {
  let out = '';
  let err = '';
  let child = '';
  const calls: Spawned[] = [];
  // The real spawn with stdio piped instead of inherited, so the fake CLI's report can be read.
  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const c = spawn(command, args, { ...options, stdio: 'pipe' });
    c.stdout?.setEncoding('utf8').on('data', (d: string) => (child += d));
    return c;
  };
  const o: CliIo = {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    iron,
    env: {},
    spawn: spawnFn,
    ...extra,
  };
  return {
    io: o,
    out: () => out,
    err: () => err,
    calls,
    report: () =>
      JSON.parse(child) as {
        args: string[];
        homeEnv: string;
        home: string;
        keys: Record<string, string | null>;
        extra: string | null;
      },
  };
}

describe('iron-proxy run', () => {
  it('starts the vendor CLI as the first ready account with the scrubbed env, extra args and its exit code', async () => {
    const first = await account('First');
    const second = await account('Second', {
      env: { FAKE_EXTRA: 'from-profile', ANTHROPIC_API_KEY: 'sk-ant-profile-should-strip' },
    });
    await iron.router.park(first, { kind: 'rate-limit', source: 'status' });

    const r = io();
    const code = await runCli(
      ['run', 'anthropic', '--', 'echo-run', '--exit', '7', 'two words', 'a"b'],
      r.io,
    );
    expect(code).toBe(7);
    expect(r.err()).toBe('Using "Second" (anthropic)\n');
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.command.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(call.args).toEqual([FAKE, 'echo-run', '--exit', '7', 'two words', 'a"b']);
    expect(call.options.stdio).toBe('inherit');
    expect(call.options.shell).toBe(false);
    const env = call.options.env as Record<string, string>;
    expect(env.CLAUDE_CONFIG_DIR).toBe(second.cli!.home);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();

    const rep = r.report();
    expect(rep.args).toEqual(['--exit', '7', 'two words', 'a"b']);
    expect(rep.homeEnv).toBe('CLAUDE_CONFIG_DIR');
    expect(rep.home).toBe(second.cli!.home);
    expect(rep.keys).toEqual({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null });
    expect(rep.extra).toBe('from-profile');

    // --profile pins an account; exit code 0 propagates too.
    const pinned = io();
    expect(await runCli(['run', 'anthropic', '--profile', first.id, 'echo-run'], pinned.io)).toBe(
      0,
    );
    // First is parked, so the pin is honoured with a note saying so.
    expect(pinned.err()).toMatch(
      /^Using "First" \(anthropic\)\nNote: "First" is parked until .+; it may refuse requests\.\n$/,
    );
    expect(pinned.report().home).toBe(first.cli!.home);
  });

  it('refuses with a hint when every account is parked, or the pinned one is not a cli account of that provider', async () => {
    const a = await account('A');
    await iron.router.park(a, {
      kind: 'quota-exhausted',
      source: 'status',
      resetAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const r = io();
    expect(await runCli(['run', 'anthropic', 'echo-run'], r.io)).toBe(1);
    expect(r.err()).toMatch(/^ALL_PROFILES_EXHAUSTED: Every anthropic account is parked/);
    expect(r.err()).toContain('\nhint: Wait until');
    expect(r.calls).toHaveLength(0);

    const key = await iron.createProfile({ title: 'Key', provider: 'anthropic', lane: 'api-key' });
    const k = io();
    expect(await runCli(['run', 'anthropic', '--profile', key.id], k.io)).toBe(1);
    expect(k.err()).toMatch(/^INVALID_REQUEST: Profile "Key" is a anthropic api-key account/);

    const o = io();
    expect(await runCli(['run', 'openai', '--profile', a.id], o.io)).toBe(1);
    expect(o.err()).toContain('INVALID_REQUEST');

    const n = io();
    expect(await runCli(['run', 'google'], n.io)).toBe(1);
    expect(n.err()).toMatch(/^NO_PROFILE/);
  });

  it('says how to install the vendor CLI when its binary is missing', async () => {
    const reg = createDefaultRegistry().addLane(
      'anthropic',
      new CliLane({ ...claudeSpec, binary: 'claude-not-installed-anywhere' }),
    );
    await iron.close();
    iron = createIronProxy({ dataDir: join(dir, 'data2'), registry: reg });
    const p = await iron.createProfile({ title: 'X', provider: 'anthropic', lane: 'cli' });
    await iron.states.put({ profileId: p.id, status: 'ready', served: 0 });
    const r = io();
    expect(await runCli(['run', 'anthropic'], r.io)).toBe(1);
    expect(r.err()).toContain('CLI_NOT_FOUND');
    expect(r.calls).toHaveLength(0);
  });
});

describe('iron-proxy env', () => {
  it('prints the lines for bash, PowerShell and cmd, never PATH or a key', async () => {
    const p = await account("It's mine", {
      env: { FAKE_EXTRA: 'x', ANTHROPIC_API_KEY: 'sk-ant-profile-should-strip', PATH: '/evil' },
    });
    const home = p.cli!.home;
    expect(home).toContain("'");

    const bash = io();
    expect(await runCli(['env', 'anthropic', '--shell', 'bash'], bash.io)).toBe(0);
    const bashLines = bash.out().trim().split('\n');
    expect(bashLines[0]).toBe(`export CLAUDE_CONFIG_DIR='${home.replace(/'/g, `'\\''`)}'`);
    expect(bashLines[1]).toBe("export FAKE_EXTRA='x'");
    expect(bashLines[2]).toMatch(/^unset ANTHROPIC_API_KEY .*OPENAI_API_KEY/);
    expect(bashLines).toHaveLength(3);
    expect(bash.err()).toContain(`Using "It's mine" (anthropic)`);
    expect(bash.err()).toContain('only iron-proxy run anthropic starts the CLI');

    const ps = io();
    expect(await runCli(['env', 'anthropic', '--shell', 'powershell'], ps.io)).toBe(0);
    const psLines = ps.out().trim().split('\n');
    expect(psLines[0]).toBe(`$env:CLAUDE_CONFIG_DIR = '${home.replace(/'/g, "''")}'`);
    expect(psLines).toContain('Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue');

    const cmd = io();
    expect(await runCli(['env', 'anthropic', '--shell', 'cmd'], cmd.io)).toBe(0);
    expect(cmd.out()).toBe(`set "CLAUDE_CONFIG_DIR=${home}"\nset "FAKE_EXTRA=x"\n`);
    expect(cmd.err()).toContain('API-key variables are unset only by iron-proxy run anthropic');

    for (const r of [bash, ps, cmd]) {
      expect(r.out()).not.toContain('sk-ant');
      expect(r.out()).not.toContain('/evil');
      expect(r.out()).not.toMatch(/\bPATH=/);
      expect(r.calls).toHaveLength(0);
    }
  });

  it('uses a pinned parked or signed-out account but says so on stderr (run and env)', async () => {
    const parked = await account('Parked One');
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await iron.router.park(parked, { kind: 'quota-exhausted', source: 'status', resetAt: until });
    const local = new Date(until).toLocaleString();

    const e = io();
    expect(
      await runCli(['env', 'anthropic', '--shell', 'bash', '--profile', parked.id], e.io),
    ).toBe(0);
    expect(e.out()).toContain(`export CLAUDE_CONFIG_DIR=`);
    expect(e.err()).toContain(
      `Note: "Parked One" is parked until ${local}; it may refuse requests.\n`,
    );

    const r = io();
    expect(await runCli(['run', 'anthropic', '--profile', parked.id, 'echo-run'], r.io)).toBe(0);
    expect(r.err()).toContain(
      `Note: "Parked One" is parked until ${local}; it may refuse requests.\n`,
    );
    expect(r.report().home).toBe(parked.cli!.home);

    const out = await iron.createProfile({
      title: 'Signed Out',
      provider: 'anthropic',
      lane: 'cli',
      cli: { home: join(dir, 'homes', 'signed-out') },
    });
    await iron.refreshStatus(out.id);
    expect((await iron.allStates())[out.id]?.status).toBe('unauthenticated');
    const s = io();
    expect(await runCli(['env', 'anthropic', '--shell', 'bash', '--profile', out.id], s.io)).toBe(
      0,
    );
    expect(s.err()).toContain(`Note: "Signed Out" is not signed in: iron-proxy login ${out.id}\n`);
    const sr = io();
    expect(await runCli(['run', 'anthropic', '--profile', out.id, 'echo-run'], sr.io)).toBe(0);
    expect(sr.err()).toContain(`Note: "Signed Out" is not signed in: iron-proxy login ${out.id}\n`);

    // A ready pinned account, and an unpinned pick, print no note.
    const ready = await account('Ready');
    const q = io();
    expect(await runCli(['env', 'anthropic', '--shell', 'bash', '--profile', ready.id], q.io)).toBe(
      0,
    );
    expect(q.err()).not.toContain('Note: "Ready"');
    for (const x of [e, r, s, sr, q]) expect(x.err()).not.toMatch(/@/);
  });

  it('defaults to PowerShell on Windows and bash elsewhere, and rejects an unknown shell', async () => {
    await account('A');
    const w = io({ platform: 'win32' });
    expect(await runCli(['env', 'anthropic'], w.io)).toBe(0);
    expect(w.out()).toMatch(/^\$env:CLAUDE_CONFIG_DIR = '/);
    const l = io({ platform: 'linux' });
    expect(await runCli(['env', 'anthropic'], l.io)).toBe(0);
    expect(l.out()).toMatch(/^export CLAUDE_CONFIG_DIR='/);
    const f = io();
    expect(await runCli(['env', 'anthropic', '--shell', 'fish'], f.io)).toBe(1);
    expect(f.err()).toContain('Unknown shell "fish"');
  });
});
