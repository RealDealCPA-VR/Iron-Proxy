import { spawn } from 'node:child_process';
import type { LoginCommandInfo } from '@iron-proxy/core';

export type Platform = 'win32' | 'darwin' | 'linux';

/** Quote one argument for the given platform's shell. */
export function shellQuote(arg: string, platform: Platform): string {
  if (platform === 'win32') {
    // cmd.exe: wrap in double quotes, double any embedded quote, escape metacharacters with ^.
    if (arg === '') return '""';
    if (!/[\s"&|<>^%()!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""').replace(/[&|<>^%()!]/g, (c) => `^${c}`)}"`;
  }
  // POSIX: single quotes, with embedded single quotes closed/escaped/reopened.
  if (arg === '') return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Environment variables the vendor CLI needs that differ from the parent shell's. */
export function relevantEnv(cmd: LoginCommandInfo): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cmd.env)) {
    if (process.env[k] === v) continue; // already the same in the user's shell
    if (
      [
        'PATH',
        'Path',
        'HOME',
        'USERPROFILE',
        'TEMP',
        'TMP',
        'SystemRoot',
        'ComSpec',
        'PATHEXT',
        'CI',
        'NO_COLOR',
        'FORCE_COLOR',
      ].includes(k)
    )
      continue;
    out[k] = v;
  }
  return out;
}

/**
 * One line a user could paste into a terminal to run the login themselves,
 * with the isolated-home environment set inline.
 */
export function loginTerminalCommandString(
  cmd: LoginCommandInfo,
  platform: Platform = process.platform as Platform,
): string {
  const env = relevantEnv(cmd);
  const argv = [cmd.binary, ...cmd.args].map((a) => shellQuote(a, platform)).join(' ');
  if (platform === 'win32') {
    const sets = Object.entries(env).map(([k, v]) => `set ${shellQuote(`${k}=${v}`, 'win32')}`);
    return [...sets, argv].join(' && ');
  }
  const exports = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v, platform)}`);
  return exports.length ? `${exports.join(' ')} ${argv}` : argv;
}

export interface OpenLoginTerminalOptions {
  platform?: Platform;
  /** Injected for tests. Default node:child_process.spawn. */
  spawn?: typeof spawn;
  /** Linux only: terminal emulators to try, in order. */
  linuxTerminals?: string[];
}

const LINUX_TERMINALS: Array<{ bin: string; prefix: string[] }> = [
  { bin: 'x-terminal-emulator', prefix: ['-e'] },
  { bin: 'gnome-terminal', prefix: ['--'] },
  { bin: 'konsole', prefix: ['-e'] },
  { bin: 'xfce4-terminal', prefix: ['-e'] },
  { bin: 'xterm', prefix: ['-e'] },
];

/**
 * Open a visible terminal window that runs the vendor CLI's login with the
 * profile's isolated home. Used when the CLI insists on an interactive TTY
 * (Gemini) or when the host prefers the user to see the vendor's own flow.
 */
export async function openLoginTerminal(
  cmd: LoginCommandInfo,
  opts: OpenLoginTerminalOptions = {},
): Promise<{ pid?: number | undefined }> {
  const platform = opts.platform ?? (process.platform as Platform);
  const doSpawn = opts.spawn ?? spawn;
  const env = { ...process.env, ...cmd.env } as Record<string, string>;
  const argv = [cmd.binary, ...cmd.args];

  if (platform === 'win32') {
    // `start "" cmd /k <command>` keeps the window open after the CLI exits so the user can read the result.
    const inner = argv.map((a) => shellQuote(a, 'win32')).join(' ');
    const child = doSpawn('cmd.exe', ['/c', 'start', '"Iron-Proxy login"', 'cmd', '/k', inner], {
      env,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
    return { pid: child.pid };
  }

  if (platform === 'darwin') {
    // Terminal.app does not inherit our env, so the exports go into the script.
    const script = loginTerminalCommandString(cmd, 'darwin');
    const osa = `tell application "Terminal"\n activate\n do script ${JSON.stringify(script)}\nend tell`;
    const child = doSpawn('osascript', ['-e', osa], { env, detached: true, stdio: 'ignore' });
    child.unref();
    return { pid: child.pid };
  }

  const terminals = opts.linuxTerminals
    ? opts.linuxTerminals.map(
        (bin) => LINUX_TERMINALS.find((t) => t.bin === bin) ?? { bin, prefix: ['-e'] },
      )
    : LINUX_TERMINALS;
  // Run through `sh -c` so the window stays open long enough to read the outcome.
  const script = `${argv.map((a) => shellQuote(a, 'linux')).join(' ')}; echo; echo "Login finished. Press Enter to close."; read _`;
  let lastError: Error | undefined;
  for (const t of terminals) {
    try {
      const child = doSpawn(t.bin, [...t.prefix, 'sh', '-c', script], {
        env,
        detached: true,
        stdio: 'ignore',
      });
      const pid = await new Promise<number | undefined>((resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', () => resolve(child.pid));
      });
      child.unref();
      return { pid };
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw new Error(
    `No terminal emulator found (tried ${terminals.map((t) => t.bin).join(', ')}): ${lastError?.message ?? ''}`,
  );
}
