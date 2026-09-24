import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { CliError } from '../../errors.js';

export interface SpawnOptions {
  binary: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Environment passed to every vendor CLI spawn: PATH, HOME, temp dirs, no inherited API keys. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
    'SystemRoot',
    'SYSTEMROOT',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'LANG',
    'LC_ALL',
    'TERM',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'SHELL',
    'NO_COLOR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.CI = '1';
  return { ...env, ...extra };
}

/** Run to completion, collecting output. */
export function run(opts: SpawnOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(opts.binary, opts.args, {
        env: opts.env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      return reject(
        new CliError('CLI_FAILED', `Cannot spawn ${opts.binary}: ${(err as Error).message}`),
      );
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err.code === 'ENOENT') {
        reject(
          new CliError('CLI_NOT_FOUND', `"${opts.binary}" is not installed or not on PATH.`, {
            binary: opts.binary,
          }),
        );
      } else {
        reject(
          new CliError('CLI_FAILED', `${opts.binary}: ${err.message}`, { binary: opts.binary }),
        );
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
    else child.stdin?.end();
  });
}

export interface LineStream {
  lines: AsyncIterable<{ source: 'stdout' | 'stderr'; line: string }>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill(): void;
  child: ChildProcess;
}

/** Spawn and yield output line by line as it arrives. */
export function spawnLines(opts: SpawnOptions): LineStream {
  const child = spawn(opts.binary, opts.args, {
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  const queue: Array<{ source: 'stdout' | 'stderr'; line: string }> = [];
  let waiter: (() => void) | undefined;
  let closed = false;
  let spawnError: Error | undefined;

  const push = (source: 'stdout' | 'stderr', chunk: string, buf: { s: string }) => {
    buf.s += chunk;
    let idx: number;
    while ((idx = buf.s.indexOf('\n')) >= 0) {
      const line = buf.s.slice(0, idx).replace(/\r$/, '');
      buf.s = buf.s.slice(idx + 1);
      queue.push({ source, line });
    }
    waiter?.();
  };
  const outBuf = { s: '' };
  const errBuf = { s: '' };
  child.stdout?.setEncoding('utf8').on('data', (d: string) => push('stdout', d, outBuf));
  child.stderr?.setEncoding('utf8').on('data', (d: string) => push('stderr', d, errBuf));

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError =
        err.code === 'ENOENT'
          ? new CliError('CLI_NOT_FOUND', `"${opts.binary}" is not installed or not on PATH.`, {
              binary: opts.binary,
            })
          : new CliError('CLI_FAILED', `${opts.binary}: ${err.message}`, { binary: opts.binary });
      closed = true;
      waiter?.();
      resolve({ code: null, signal: null });
    });
    child.on('close', (code, signal) => {
      if (outBuf.s) queue.push({ source: 'stdout', line: outBuf.s });
      if (errBuf.s) queue.push({ source: 'stderr', line: errBuf.s });
      closed = true;
      waiter?.();
      resolve({ code, signal });
    });
  });

  const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : undefined;
  timer?.unref?.();
  opts.signal?.addEventListener('abort', () => child.kill(), { once: true });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  else child.stdin?.end();

  const lines: AsyncIterable<{ source: 'stdout' | 'stderr'; line: string }> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (closed) {
          if (timer) clearTimeout(timer);
          if (spawnError) throw spawnError;
          return;
        }
        await new Promise<void>((r) => (waiter = r));
        waiter = undefined;
      }
    },
  };

  return { lines, exit, kill: () => child.kill(), child };
}

/** Locate an executable on PATH (Windows-aware). Returns the resolved path or undefined. */
export async function which(binary: string): Promise<string | undefined> {
  const { access } = await import('node:fs/promises');
  const { isAbsolute, join } = await import('node:path');
  if (isAbsolute(binary)) {
    try {
      await access(binary);
      return binary;
    } catch {
      return undefined;
    }
  }
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  // On Windows a bare name ("claude") is tried with each PATHEXT extension only:
  // npm installs an extensionless sh script next to claude.cmd, and that script
  // cannot be started on Windows. A name that already has an extension is taken as-is.
  const exts =
    process.platform === 'win32'
      ? /\.[^\\/.]+$/.test(binary)
        ? ['']
        : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, binary + ext.toLowerCase());
      try {
        await access(candidate);
        return candidate;
      } catch {
        /* next */
      }
    }
  }
  return undefined;
}
