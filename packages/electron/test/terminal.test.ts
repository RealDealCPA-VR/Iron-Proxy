import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { LoginCommandInfo } from '@iron-proxy/core';
import {
  loginTerminalCommandString,
  openLoginTerminal,
  relevantEnv,
  shellQuote,
} from '../src/terminal.js';

const cmd: LoginCommandInfo = {
  binary: 'claude',
  args: ['auth', 'login'],
  env: {
    CLAUDE_CONFIG_DIR: 'C:\\Users\\Me\\App Data\\iron-proxy\\cli-homes\\anthropic\\p1',
    NO_COLOR: '1',
    PATH: process.env.PATH ?? '',
  },
  requiresTerminal: false,
};

describe('shellQuote', () => {
  it('posix', () => {
    expect(shellQuote('simple', 'linux')).toBe('simple');
    expect(shellQuote('has space', 'darwin')).toBe("'has space'");
    expect(shellQuote("it's", 'linux')).toBe(`'it'\\''s'`);
    expect(shellQuote('', 'linux')).toBe("''");
    expect(shellQuote('$HOME;rm -rf /', 'linux')).toBe("'$HOME;rm -rf /'");
  });
  it('win32', () => {
    expect(shellQuote('simple', 'win32')).toBe('simple');
    expect(shellQuote('has space', 'win32')).toBe('"has space"');
    expect(shellQuote('say "hi"', 'win32')).toBe('"say ""hi"""');
    expect(shellQuote('a&b|c', 'win32')).toBe('"a^&b^|c"');
    expect(shellQuote('', 'win32')).toBe('""');
  });
});

describe('relevantEnv + loginTerminalCommandString', () => {
  it('keeps only the isolating variables', () => {
    const env = relevantEnv(cmd);
    expect(Object.keys(env)).toEqual(['CLAUDE_CONFIG_DIR']);
  });
  it('renders a pasteable line per platform', () => {
    const win = loginTerminalCommandString(cmd, 'win32');
    expect(win).toBe(
      'set "CLAUDE_CONFIG_DIR=C:\\Users\\Me\\App Data\\iron-proxy\\cli-homes\\anthropic\\p1" && claude auth login',
    );
    const mac = loginTerminalCommandString(cmd, 'darwin');
    expect(mac).toBe(
      "CLAUDE_CONFIG_DIR='C:\\Users\\Me\\App Data\\iron-proxy\\cli-homes\\anthropic\\p1' claude auth login",
    );
    expect(loginTerminalCommandString({ ...cmd, env: {} }, 'linux')).toBe('claude auth login');
  });
});

function fakeSpawn(
  record: Array<{ bin: string; args: string[]; env: Record<string, string | undefined> }>,
  failFor: string[] = [],
) {
  return ((bin: string, args: string[], opts: { env: Record<string, string | undefined> }) => {
    record.push({ bin, args, env: opts.env });
    const child = new EventEmitter() as EventEmitter & { pid?: number; unref(): void };
    child.pid = 4242;
    child.unref = () => {};
    setImmediate(() => {
      if (failFor.includes(bin))
        child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      else child.emit('spawn');
    });
    return child;
  }) as unknown as typeof spawn;
}

describe('openLoginTerminal', () => {
  it('win32 uses start + cmd /k with the isolated env', async () => {
    const rec: Array<{ bin: string; args: string[]; env: Record<string, string | undefined> }> = [];
    const r = await openLoginTerminal(cmd, { platform: 'win32', spawn: fakeSpawn(rec) });
    expect(r.pid).toBe(4242);
    expect(rec[0]?.bin).toBe('cmd.exe');
    expect(rec[0]?.args.slice(0, 5)).toEqual(['/c', 'start', '"Iron-Proxy login"', 'cmd', '/k']);
    expect(rec[0]?.args[5]).toBe('claude auth login');
    expect(rec[0]?.env.CLAUDE_CONFIG_DIR).toBe(cmd.env.CLAUDE_CONFIG_DIR);
  });
  it('darwin drives Terminal.app through osascript with exports inline', async () => {
    const rec: Array<{ bin: string; args: string[]; env: Record<string, string | undefined> }> = [];
    await openLoginTerminal(cmd, { platform: 'darwin', spawn: fakeSpawn(rec) });
    expect(rec[0]?.bin).toBe('osascript');
    expect(rec[0]?.args[1]).toContain('do script');
    expect(rec[0]?.args[1]).toContain('CLAUDE_CONFIG_DIR=');
  });
  it('linux tries emulators in order and reports when none exist', async () => {
    const rec: Array<{ bin: string; args: string[]; env: Record<string, string | undefined> }> = [];
    await openLoginTerminal(cmd, {
      platform: 'linux',
      spawn: fakeSpawn(rec, ['x-terminal-emulator', 'gnome-terminal']),
    });
    expect(rec.map((r) => r.bin)).toEqual(['x-terminal-emulator', 'gnome-terminal', 'konsole']);
    expect(rec[2]?.args.slice(0, 3)).toEqual(['-e', 'sh', '-c']);
    expect(rec[2]?.args[3]).toContain('claude auth login');

    await expect(
      openLoginTerminal(cmd, {
        platform: 'linux',
        spawn: fakeSpawn([], ['xterm']),
        linuxTerminals: ['xterm'],
      }),
    ).rejects.toThrow(/No terminal emulator/);
  });
});
