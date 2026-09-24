import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { which } from '@iron-proxy/core';
import { buildLaunch, escapeCmdArgument, escapeCmdCommand } from '../src/index.js';

describe('buildLaunch', () => {
  it('runs an executable directly, without a shell', () => {
    expect(buildLaunch('/usr/bin/claude', ['--resume', 'a b'], 'linux')).toEqual({
      command: '/usr/bin/claude',
      args: ['--resume', 'a b'],
    });
    expect(buildLaunch('C:\\bin\\claude.exe', ['x'], 'win32')).toEqual({
      command: 'C:\\bin\\claude.exe',
      args: ['x'],
    });
  });

  it('runs a Windows .cmd/.bat shim through cmd.exe /d /s /c with every part escaped', () => {
    const spec = buildLaunch(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      ['--model', 'a b&c'],
      'win32',
      'C:\\Windows\\system32\\cmd.exe',
    );
    expect(spec.command).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(spec.windowsVerbatimArguments).toBe(true);
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spec.args[3]).toBe(
      '"C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd ^^^"--model^^^" ^^^"a^^^ b^^^&c^^^""',
    );
    expect(buildLaunch('C:\\x\\y.BAT', [], 'win32', 'cmd.exe').command).toBe('cmd.exe');
  });

  it('escapes quotes, backslashes and cmd metacharacters', () => {
    expect(escapeCmdCommand('C:\\Program Files\\x (1)\\a.cmd')).toBe(
      'C:\\Program^ Files\\x^ ^(1^)\\a.cmd',
    );
    expect(escapeCmdArgument('plain', false)).toBe('^"plain^"');
    expect(escapeCmdArgument('a"b', false)).toBe('^"a\\^"b^"');
    expect(escapeCmdArgument('dir\\', false)).toBe('^"dir\\\\^"');
    expect(escapeCmdArgument('x|y>z%', false)).toBe('^"x^|y^>z^%^"');
    expect(escapeCmdArgument('', false)).toBe('^"^"');
    expect(escapeCmdArgument('&')).toBe('^^^"^^^&^^^"');
  });
});

describe.runIf(process.platform === 'win32')('a real .cmd shim on Windows', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'iron-cli-shim-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('receives every argument exactly as given, through a path with spaces', async () => {
    const bin = join(dir, 'with space (x)');
    await mkdir(bin);
    await writeFile(
      join(bin, 'echo-args.mjs'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    // The shape npm's shims have: forward every argument with %*.
    await writeFile(
      join(bin, 'echoargs.cmd'),
      `@"${process.execPath}" "%~dp0echo-args.mjs" %*\r\n`,
    );
    const saved = process.env.PATH; // process.env is case-insensitive on Windows
    process.env.PATH = `${bin};${saved ?? ''}`;
    let resolved: string | undefined;
    try {
      resolved = await which('echoargs');
    } finally {
      process.env.PATH = saved;
    }
    expect(resolved?.toLowerCase()).toBe(join(bin, 'echoargs.cmd').toLowerCase());

    const args = [
      'plain',
      'two words',
      'a&b',
      'x|y',
      'quote"inside',
      '50%',
      'caret^',
      '(paren)',
      '<angle>',
      'trailing\\',
      'semi;colon,comma',
      '',
    ];
    const spec = buildLaunch(resolved!, args);
    const got = await new Promise<string>((resolve, reject) => {
      const c = spawn(spec.command, spec.args, {
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
      let s = '';
      c.stdout.setEncoding('utf8').on('data', (d: string) => (s += d));
      c.on('error', reject);
      c.on('close', () => resolve(s));
    });
    expect(JSON.parse(got)).toEqual(args);
  });
});
