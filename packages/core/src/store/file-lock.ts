import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Cross-process locking and change detection for the JSON files the CLI, a
 * running `serve` and the tray app share in one data directory.
 *
 * The lock is a small file next to the data file (`<file>.lock`), created with
 * the exclusive `wx` flag: whoever creates it holds the lock. A holder that
 * crashed leaves it behind, so a lock older than `staleMs` is removed and taken
 * over. Every read-merge-write of a shared store runs inside it.
 *
 * Taking over a stale lock must not race another waiter doing the same: with a
 * plain check-then-unlink, the second waiter deletes the lock the first one has
 * just created and both run at once. See `takeOverStale`.
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
  // Used in a file name too, so only characters every file system accepts.
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const started = Date.now();
  let delay = 5;
  await mkdir(dirname(lock), { recursive: true });
  for (;;) {
    if (await createExclusive(lock, token)) break;
    let stale: boolean;
    try {
      stale = Date.now() - (await stat(lock)).mtimeMs > staleMs;
    } catch {
      continue; // released between our open and stat: try again at once
    }
    if (stale && (await takeOverStale(lock, token, staleMs))) continue;
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

/** Create `path` exclusively with `content`. False when it already exists. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  try {
    const fh = await open(path, 'wx', 0o600);
    try {
      await fh.writeFile(content, 'utf8');
    } finally {
      await fh.close();
    }
    return true;
  } catch (err) {
    const c = code(err);
    // EPERM/EACCES: Windows reports these while another process is deleting the file.
    if (c !== 'EEXIST' && c !== 'EPERM' && c !== 'EACCES') throw err;
    return false;
  }
}

/**
 * Move a stale lock out of the way. Returns true when the caller should try to
 * create the lock again at once, false when it should wait as for a live lock.
 *
 * Only the waiter holding `<file>.lock.takeover` may remove a stale lock, and it
 * looks at the lock again once it holds it: nobody else removes a stale lock in
 * the meantime, so nobody can have replaced it with a live one, and what it
 * removes is the stale lock it has just seen. It renames the lock to a name only
 * it uses (`<file>.lock.stale-<token>`), which frees the name at once even where
 * Windows keeps a deleted file's name while someone has it open, then deletes
 * that. A rename that finds nothing (ENOENT) means the lock went away: retry.
 */
async function takeOverStale(lock: string, token: string, staleMs: number): Promise<boolean> {
  const guard = `${lock}.takeover`;
  if (!(await createExclusive(guard, token))) {
    // Another waiter is taking it over. A guard this old was left by a waiter
    // that crashed in the middle of a takeover, which is all but impossible.
    try {
      if (Date.now() - (await stat(guard)).mtimeMs > staleMs) await unlink(guard);
    } catch {
      /* gone already */
    }
    return false;
  }
  try {
    try {
      if (Date.now() - (await stat(lock)).mtimeMs <= staleMs) return false; // taken over already
    } catch {
      return true; // gone: try again at once
    }
    const grave = `${lock}.stale-${token}`;
    try {
      await rename(lock, grave);
    } catch (err) {
      // ENOENT: gone after all. Anything else (Windows refuses to rename a file
      // someone has open): wait, then look again.
      return code(err) === 'ENOENT';
    }
    await unlink(grave).catch(() => {});
    return true;
  } finally {
    try {
      if ((await readFile(guard, 'utf8')) === token) await unlink(guard);
    } catch {
      /* gone already */
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
