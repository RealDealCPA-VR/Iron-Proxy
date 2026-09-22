import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIronProxy, type IronProxy } from '@iron-proxy/core';
import { runCli, readProxyDescriptor, table, type CliIo } from '../src/index.js';

const FAKE = fileURLToPath(
  new URL('../../core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url),
);

let dir: string;
let iron: IronProxy;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-cli-pkg-'));
  iron = createIronProxy({ dataDir: dir });
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

function io(extra: Partial<CliIo> = {}) {
  let out = '';
  let err = '';
  const o: CliIo = {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    iron,
    env: { IRON_PROXY_DATA_DIR: dir },
    ...extra,
  };
  return { io: o, out: () => out, err: () => err };
}

describe('iron-proxy CLI', () => {
  it('prints help and rejects unknown commands', async () => {
    const h = io();
    expect(await runCli(['--help'], h.io)).toBe(0);
    expect(h.out()).toContain('Usage:');
    const u = io();
    expect(await runCli(['bogus'], u.io)).toBe(2);
    expect(u.err()).toContain('Unknown command');
  });

  it('adds, lists, renames, activates and removes profiles', async () => {
    const a = io({ readStdin: async () => 'key-A\n' });
    expect(
      await runCli(
        [
          'profiles',
          'add',
          '--provider',
          'anthropic',
          '--lane',
          'api-key',
          '--title',
          'Work',
          '--api-key-stdin',
        ],
        a.io,
      ),
    ).toBe(0);
    expect(a.out()).toMatch(/Created prof_/);
    expect(a.out()).not.toContain('key-A');
    const b = io();
    expect(
      await runCli(
        ['profiles', 'add', '--provider', 'anthropic', '--lane', 'api-key', '--title', 'Home'],
        b.io,
      ),
    ).toBe(0);

    const list = io();
    expect(await runCli(['profiles', 'list', '--json'], list.io)).toBe(0);
    const parsed = JSON.parse(list.out()) as Array<{ id: string; title: string; order: number }>;
    expect(parsed.map((p) => p.title)).toEqual(['Work', 'Home']);
    const [work, home] = parsed;

    const r = io();
    expect(await runCli(['profiles', 'rename', home!.id, 'Personal'], r.io)).toBe(0);
    const act = io();
    expect(await runCli(['profiles', 'activate', home!.id], act.io)).toBe(0);
    expect((await iron.listProfiles('anthropic')).map((p) => p.title)).toEqual([
      'Personal',
      'Work',
    ]);

    const dis = io();
    expect(await runCli(['profiles', 'disable', work!.id], dis.io)).toBe(0);
    expect((await iron.getProfile(work!.id)).enabled).toBe(false);

    const st = io();
    expect(await runCli(['status'], st.io)).toBe(0);
    expect(st.out()).toContain('Personal');

    const rm1 = io();
    expect(await runCli(['profiles', 'remove', work!.id], rm1.io)).toBe(0);
    expect((await iron.listProfiles()).length).toBe(1);
  });

  it('validates add arguments', async () => {
    const x = io();
    expect(await runCli(['profiles', 'add', '--provider', 'nope', '--title', 'T'], x.io)).toBe(1);
    expect(x.err()).toContain('--provider must be one of');
    const y = io();
    expect(await runCli(['profiles', 'add', '--provider', 'anthropic'], y.io)).toBe(1);
    expect(y.err()).toContain('--title is required');
  });

  it('logs a CLI profile in through the fake vendor CLI and chats through it', async () => {
    const p = await iron.createProfile({
      title: 'Fake Claude',
      provider: 'anthropic',
      lane: 'cli',
      cli: { binary: FAKE, env: { FAKE_CLI_FLAVOR: 'claude' } } as never,
    });
    const term = io();
    expect(await runCli(['login', p.id, '--terminal'], term.io)).toBe(0);
    expect(term.out()).toContain('CLAUDE_CONFIG_DIR');
    expect(term.out()).toContain('auth login');

    const login = io();
    expect(await runCli(['login', p.id], login.io)).toBe(0);
    expect(login.out()).toContain('https://example.test/device');
    expect(login.out()).toContain('ABCD-1234');
    expect(login.out()).toContain('Logged in.');

    const chat = io();
    expect(await runCli(['chat', 'anthropic', 'hello', 'cli'], chat.io)).toBe(0);
    expect(chat.out()).toContain('echo:hello cli');
    expect(chat.err()).toContain('served by "Fake Claude"');

    const models = io();
    expect(await runCli(['models', p.id], models.io)).toBe(0);

    const out = io();
    expect(await runCli(['logout', p.id], out.io)).toBe(0);
    expect((await iron.allStates())[p.id]?.status).toBe('unauthenticated');
  });

  it('doctor reports the four vendor CLIs as JSON', async () => {
    const d = io();
    expect(await runCli(['doctor', '--json'], d.io)).toBe(0);
    const probes = JSON.parse(d.out()) as Array<{ binary: string }>;
    expect(probes.map((p) => p.binary).sort()).toEqual(['claude', 'codex', 'gemini', 'grok']);
  });

  it('serve writes and removes the descriptor and answers health', async () => {
    let release!: () => void;
    const shutdown = new Promise<void>((r) => (release = r));
    const s = io({ waitForShutdown: () => shutdown });
    const run = runCli(['serve', '--port', '0'], s.io);
    let desc: Awaited<ReturnType<typeof readProxyDescriptor>>;
    for (let i = 0; i < 100 && !desc; i++) {
      desc = await readProxyDescriptor(dir);
      if (!desc) await new Promise((r) => setTimeout(r, 50));
    }
    expect(desc).toBeDefined();
    const health = await fetch(`${desc!.url}/iron/health`, {
      headers: { authorization: `Bearer ${desc!.token}` },
    });
    expect(health.ok).toBe(true);
    expect(s.out()).toContain('Iron-Proxy listening on');
    expect(s.out()).toContain(desc!.token);
    release();
    expect(await run).toBe(0);
    await expect(stat(join(dir, 'proxy.json'))).rejects.toThrow();
    void readFile;
  });

  it('table pads columns', () => {
    const t = table(['a', 'bb'], [['1', '2']]);
    expect(t.split('\n')[0]).toBe('a  bb');
  });
});
