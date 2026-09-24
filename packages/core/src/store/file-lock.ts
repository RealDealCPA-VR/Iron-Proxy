import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Cross-process locking and change detection for the JSON files the CLI, a
 * running `serve` and the tray app share in one data directory.
 *
 * The lock is a small file next to the data file (`<file>.lock`), created with
 * the exclusive `wx` flag: whoever creates it holds the lock. A holder that
 * crashed leaves it behind, so a lock older than `staleMs` is removed and taken
 * over. Every read-merge-write of a shared store runs inside it.
 */

export interface FileLockOptions {
  /** Give up after this long. Default 2000 ms. */
  timeoutMs?: number;
  /** A lock file older than this is left over from a crash and is removed. Default 10000 ms. */
  staleMs?: number;
}

export const LOCK_TIMEOUT_MS = 2_000;
export const LOCK_STALE_MS = 10_000;

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** The lock path for a data file. */
export function lockPathFor(path: string): string {
  return `${path}.lock`;
}

/** Run `fn` while holding `<path>.lock`, releasing it however `fn` ends. */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const lock = lockPathFor(path);
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const token = `${process.pid}:${randomBytes(6).toString('hex')}`;
  const started = Date.now();
  let delay = 5;
  await mkdir(dirname(lock), { recursive: true });
  for (;;) {
    try {
      const fh = await open(lock, 'wx', 0o600);
      try {
        await fh.writeFile(token, 'utf8');
      } finally {
        await fh.close();
      }
      break;
    } catch (err) {
      const c = code(err);
      // EPERM/EACCES: Windows reports these while another process is deleting the file.
      if (c !== 'EEXIST' && c !== 'EPERM' && c !== 'EACCES') throw err;
    }
    try {
      const st = await stat(lock);
      if (Date.now() - st.mtimeMs > staleMs) {
        await unlink(lock).catch(() => {});
        continue;
      }
    } catch {
      continue; // released between our open and stat: try again at once
    }
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for the lock on ${lock}`);
    }
    await pause(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 50);
  }
  try {
    return await fn();
  } finally {
    // Remove only our own lock: a lock taken over as stale belongs to someone else now.
    try {
      if ((await readFile(lock, 'utf8')) === token) await unlink(lock);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Identity of the file as it is on disk: inode, mtime and size. Every atomic
 * replace (temp file + rename) changes it. `'missing'` when there is no file.
 */
export async function fileFingerprint(path: string): Promise<string> {
  try {
    const st = await stat(path);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}
