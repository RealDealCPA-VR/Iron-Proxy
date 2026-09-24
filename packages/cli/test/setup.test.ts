import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeSpec,
  CLI_INSTALL_HINTS,
  CliLane,
  codexSpec,
  createDefaultRegistry,
  createIronProxy,
  geminiSpec,
  grokSpec,
  type IronProxy,
} from '@iron-proxy/core';
import { PassThrough } from 'node:stream';
import { readlinePrompt } from '../src/commands.js';
import { runCli, type CliIo } from '../src/index.js';

const FAKE = fileURLToPath(
  new URL('../../core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url),
);

let dir: string;
let user: string;
let iron: IronProxy;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-cli-setup-'));
  user = join(dir, 'user');
  // A Claude Code login already on this computer; Codex installed but signed out.
  await mkdir(join(user, '.claude'), { recursive: true });
  await writeFile(join(user, '.claude', 'logged-in'), 'yes');
  await mkdir(join(user, '.codex'), { recursive: true });
  iron = createIronProxy({
    dataDir: join(dir, 'data'),
    registry: createDefaultRegistry()
      .addLane('anthropic', new CliLane({ ...claudeSpec, binary: FAKE }))
      .addLane('openai', new CliLane({ ...codexSpec, binary: FAKE }))
      .addLane('xai', new CliLane({ ...grokSpec, binary: FAKE }))
      // Gemini is not installed on this "computer".
      .addLane('google', new CliLane({ ...geminiSpec, binary: 'iron-proxy-test-no-gemini' })),
    env: { HOME: user, USERPROFILE: user },
  });
});
afterEach(async () => {
  await iron.close();
  // A background status check may still hold a home open on Windows for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** Scripted answers; records every question and whether it was asked as a secret. */
function io(answers: string[] | 'none') {
  let out = '';
  let err = '';
  const asked: Array<{ q: string; secret: boolean }> = [];
  const queue = answers === 'none' ? [] : [...answers];
  const o: CliIo = {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    iron,
    env: {},
    prompt: async (q, opts) => {
      if (answers === 'none') throw new Error(`setup --yes asked: ${q}`);
      asked.push({ q, secret: !!opts?.secret });
      return queue.shift() ?? '';
    },
  };
  return { io: o, out: () => out, err: () => err, asked, left: () => queue.length };
}

describe('iron-proxy setup', () => {
  it('checks the CLIs, adopts a found login, adds a cli account and an api-key account', async () => {
    const key = 'sk-ant-api03-SETUPSECRETvalue1234567890';
    const s = io([
      '', // Use "Claude (existing login)"? default yes
      'y', // Add another account?
      'openai', // provider (by name)
      'cli', // lane
      '', // title: default suggestion
      'y', // Add another account?
      '1', // provider: anthropic (by number)
      'api-key',
      'Backup key',
      key,
      'n', // Add another account?
    ]);
    expect(await runCli(['setup'], s.io)).toBe(0);
    const out = s.out();

    // 1. doctor, with the official install command for the missing CLI.
    expect(out).toContain('== 1. Vendor CLIs on this computer ==');
    expect(out).toMatch(/claude\s+installed/);
    expect(out).toMatch(/gemini\s+missing/);
    expect(out).toContain(CLI_INSTALL_HINTS.gemini);
    expect(out).not.toContain(CLI_INSTALL_HINTS.claude);

    // 2. the found login, asked about by its suggested title.
    expect(s.asked[0]?.q).toBe('Use "Claude (existing login)" as an account? [Y/n] ');
    // the signed-out Codex home is not offered
    expect(s.asked.filter((a) => a.q.startsWith('Use ')).map((a) => a.q)).toHaveLength(1);
    expect(out).toContain(
      `Added "Claude (existing login)" (anthropic), using ${resolve(user, '.claude')}`,
    );

    // 3. the new cli account: headless login with the URL and code.
    expect(s.asked.map((a) => a.q)).toContain('Title [Codex (subscription)]: ');
    expect(out).toContain('Open this URL to sign in: https://example.test/device');
    expect(out).toContain('Enter this code: ABCD-1234');
    expect(out).toContain('Logged in.');
    // the lane menu only offers the provider's lanes
    expect(out).toContain('cli      your subscription');
    expect(out).not.toMatch(/\d\) oauth/);

    // the key is read as a secret and appears nowhere.
    expect(s.asked.find((a) => a.q.startsWith('API key'))?.secret).toBe(true);
    expect(out).not.toContain(key);
    expect(s.err()).not.toContain(key);
    expect(s.left()).toBe(0);

    // 4. summary.
    expect(out).toContain('== 4. Your accounts ==');
    expect(out).toContain(`You're set. Try: iron-proxy chat anthropic "hello"`);

    const list = await iron.listProfiles();
    expect(list.map((p) => [p.provider, p.lane, p.title])).toEqual([
      ['anthropic', 'cli', 'Claude (existing login)'],
      ['anthropic', 'api-key', 'Backup key'],
      ['openai', 'cli', 'Codex (subscription)'],
    ]);
    const adopted = list[0]!;
    expect(adopted.cli).toEqual({ home: resolve(user, '.claude'), adopted: true });
    const codex = list[2]!;
    expect(await readFile(join(codex.cli!.home, 'logged-in'), 'utf8')).toBe('yes');
    const backup = list[1]!;
    expect(await iron.vault.get(backup.apiKey!.secretRef)).toBe(key);
    expect(backup.apiKey!.secretRef).toBe(`apikey:${backup.id}`);
  });

  it('skips a found login on "n" and keeps going after a failed step', async () => {
    const s = io(['n', 'y', 'nope', 'nope', 'nope', 'N']);
    expect(await runCli(['setup'], s.io)).toBe(0);
    expect(await iron.listProfiles()).toEqual([]);
    expect(s.err()).toContain('INVALID_REQUEST: No valid choice given.');
    expect(s.out()).toContain(`You're set. Try: iron-proxy chat anthropic "hello"`);
  });

  it('the default readline prompt keeps every piped answer, in order, then answers "" after EOF', async () => {
    const input = new PassThrough();
    let shown = '';
    const rp = readlinePrompt({ input, output: { write: (s) => (shown += String(s)) } });
    // Everything arrives in one chunk before the first question is even asked.
    input.write('y\nn\n2\nWork Claude\nsk-secret-answer\n');
    input.end();
    try {
      const answers = [
        await rp.ask('Adopt? '),
        await rp.ask('Another? '),
        await rp.ask('Provider [1-3]: '),
        await rp.ask('Title: '),
        await rp.ask('API key: ', { secret: true }),
        await rp.ask('After EOF: '),
      ];
      expect(answers).toEqual(['y', 'n', '2', 'Work Claude', 'sk-secret-answer', '']);
      expect(shown).toContain('Adopt? ');
      expect(shown).toContain('API key: ');
      expect(shown).not.toContain('sk-secret-answer');
    } finally {
      rp.close();
    }
  });

  it('on a terminal, a backspace redraw repaints the question, not readline\'s "> "', async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => true,
    });
    let shown = '';
    const rp = readlinePrompt({ input, output: { write: (s) => (shown += String(s)) } });
    try {
      const answer = rp.ask('Title: ');
      input.write('ab');
      input.write('\x7f');
      input.write('c\r');
      expect(await answer).toBe('ac');
      const redraw = shown.lastIndexOf('\u001b[0J');
      expect(redraw).toBeGreaterThanOrEqual(0);
      const after = shown.slice(redraw + '\u001b[0J'.length);
      expect(after.startsWith('Title: ')).toBe(true);
      expect(after).not.toContain('> ');
    } finally {
      rp.close();
    }
  });

  it('--yes adopts every signed-in login without asking and prints the summary', async () => {
    const s = io('none');
    expect(await runCli(['setup', '--yes'], s.io)).toBe(0);
    const list = await iron.listProfiles();
    expect(list.map((p) => p.title)).toEqual(['Claude (existing login)']);
    expect(s.out()).toContain(CLI_INSTALL_HINTS.gemini);
    expect(s.out()).toContain('== 3. Your accounts ==');
    expect(s.out()).not.toContain('Add another account');

    // Run again: nothing new to adopt.
    const again = io('none');
    expect(await runCli(['setup', '-y'], again.io)).toBe(0);
    expect(again.out()).toContain('No new signed-in vendor CLI logins found.');
    expect(await iron.listProfiles()).toHaveLength(1);
  });
});
