import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileProfileStore } from '../src/store/profile-store.js';
import { FileStateStore } from '../src/store/state-store.js';
import { FileUsageStore } from '../src/store/usage-store.js';
import type { Profile } from '../src/types.js';

/*
 * The tray app and the CLI run at the same time on one data directory. These
 * tests start real child Node processes that use the built package on the same
 * directory at the same moment, and check that nothing either of them wrote is
 * lost and nothing either deleted comes back.
 */

const PKG = fileURLToPath(new URL('..', import.meta.url));
const CHILD = fileURLToPath(new URL('./fixtures/store-child.mjs', import.meta.url));
const DIST = join(PKG, 'dist', 'index.js');
const LOCK_CHILD = fileURLToPath(new URL('./fixtures/lock-child.mjs', import.meta.url));

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

beforeAll(() => {
  // The children import dist: build it when it is missing or older than the source.
  if (existsSync(DIST) && statSync(DIST).mtimeMs >= newestMtime(join(PKG, 'src'))) return;
  const r = spawnSync('pnpm', ['run', 'build'], { cwd: PKG, shell: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`building @iron-proxy/core failed:\n${r.stdout}${r.stderr}`);
}, 120_000);

const profile = (id: string, order = 0): Profile => ({
  id,
  title: `P ${id}`,
  provider: 'anthropic',
  lane: 'api-key',
  order,
  enabled: true,
  apiKey: { secretRef: `apikey:${id}` },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

let dir: string;
const children: ChildProcess[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-multiproc-'));
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

interface Running {
  ready: Promise<void>;
  done: Promise<void>;
}

function runChild(job: string, prefix: string, count: number): Running {
  const child = spawn(process.execPath, [CHILD, dir, job, prefix, String(count)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  let onReady: () => void = () => {};
  const ready = new Promise<void>((r) => (onReady = r));
  child.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
    if (out.includes('ready')) onReady();
  });
  child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
  const done = new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0 && out.includes('done')) resolve();
      else reject(new Error(`child ${job} ${prefix} exited ${code}: ${err}`));
    });
  });
  // An early crash must not leave the test waiting for "ready".
  void done.catch(() => onReady());
  return { ready, done };
}

/** Start both children, let them load, then release them at the same moment. */
async function together(a: Running, b: Running): Promise<void> {
  await Promise.all([a.ready, b.ready]);
  await writeFile(join(dir, 'go'), '');
  await Promise.all([a.done, b.done]);
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('two processes on one data directory', () => {
  it('profiles: concurrent puts from two processes are all kept', async () => {
    await together(runChild('put-profiles', 'tray', 15), runChild('put-profiles', 'cli', 15));
    const got = (await new FileProfileStore(dir).list()).map((p) => p.id).sort();
    expect(got).toEqual([...ids('tray', 15), ...ids('cli', 15)].sort());
  }, 60_000);

  it('profiles: a delete in one process is not brought back by the other', async () => {
    const seed = new FileProfileStore(dir);
    for (const id of ids('old', 10)) await seed.put(profile(id));
    // The CLI deletes the old accounts while the tray (which loaded them) adds new ones.
    await together(runChild('delete-profiles', 'old', 10), runChild('put-profiles', 'new', 15));
    const got = (await new FileProfileStore(dir).list()).map((p) => p.id).sort();
    expect(got).toEqual(ids('new', 15).sort());
  }, 60_000);

  it('states: concurrent parks from two processes are all kept', async () => {
    await together(runChild('put-states', 'tray', 15), runChild('put-states', 'serve', 15));
    const got = Object.keys(await new FileStateStore(dir).all()).sort();
    expect(got).toEqual([...ids('tray', 15), ...ids('serve', 15)].sort());
  }, 60_000);

  it('states: a delete in one process is not brought back by the other', async () => {
    const seed = new FileStateStore(dir, { debounceMs: 1 });
    for (const id of ids('old', 10)) await seed.put({ profileId: id, status: 'ready', served: 0 });
    await seed.flush();
    await together(runChild('delete-states', 'old', 10), runChild('put-states', 'new', 15));
    const got = Object.keys(await new FileStateStore(dir).all()).sort();
    expect(got).toEqual(ids('new', 15).sort());
  }, 60_000);

  it('usage: records appended by two processes are all kept, even in one history', async () => {
    await together(runChild('add-usage', 'tray', 15), runChild('add-usage', 'cli', 15));
    const all = await new FileUsageStore(dir).all();
    expect(all.tray?.requests).toHaveLength(15);
    expect(all.cli?.requests).toHaveLength(15);
    expect(all.shared?.requests).toHaveLength(30);
  }, 60_000);
});

describe('the lock file', () => {
  it('recovers a stale lock left by a crashed process', async () => {
    const lock = join(dir, 'profiles.json.lock');
    await writeFile(lock, 'crashed');
    const old = new Date(Date.now() - 20_000);
    await utimes(lock, old, old);
    const started = Date.now();
    await new FileProfileStore(dir).put(profile('a'));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(existsSync(lock)).toBe(false);
    expect((await new FileProfileStore(dir).list()).map((p) => p.id)).toEqual(['a']);
  });

  it('waits for a live lock to be released, then writes', async () => {
    const lock = join(dir, 'state.json.lock');
    await writeFile(lock, 'busy');
    const release = setTimeout(() => void rm(lock, { force: true }), 200);
    const s = new FileStateStore(dir, { debounceMs: 1 });
    await s.put({ profileId: 'a', status: 'ready', served: 0 });
    const started = Date.now();
    await s.flush();
    clearTimeout(release);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(existsSync(lock)).toBe(false);
    expect(Object.keys(await new FileStateStore(dir).all())).toEqual(['a']);
  });

  it('gives up after the timeout without touching a live lock, and keeps the change', async () => {
    const lock = join(dir, 'usage.json.lock');
    await writeFile(lock, 'busy');
    const u = new FileUsageStore(dir, { debounceMs: 10_000, lock: { timeoutMs: 100 } });
    await u.addRequest('a', { at: new Date().toISOString(), durationMs: 1 });
    await expect(u.flush()).rejects.toThrow(/Timed out waiting for the lock/);
    expect(existsSync(lock)).toBe(true);
    await rm(lock);
    await u.flush();
    expect((await new FileUsageStore(dir).history('a')).requests).toHaveLength(1);
  });

  it('a failed profile write rejects and leaves nothing behind in the cache', async () => {
    const lock = join(dir, 'profiles.json.lock');
    await writeFile(lock, 'busy');
    const s = new FileProfileStore(dir, { lock: { timeoutMs: 100 } });
    await expect(s.put(profile('a'))).rejects.toThrow(/Timed out/);
    await rm(lock);
    expect(await s.list()).toEqual([]);
  });

  describe('stale lock taken over by several waiters at once', () => {
    // The children run src/store/file-lock.ts itself, compiled to plain
    // JavaScript here (it imports only node builtins), not the whole package.
    let moduleDir: string;
    let lockModule: string;
    beforeAll(async () => {
      moduleDir = await mkdtemp(join(tmpdir(), 'iron-lockmod-'));
      lockModule = join(moduleDir, 'file-lock.mjs');
      const src = await readFile(join(PKG, 'src', 'store', 'file-lock.ts'), 'utf8');
      const out = ts.transpileModule(src, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      await writeFile(lockModule, out.outputText);
    });
    afterAll(async () => {
      await rm(moduleDir, { recursive: true, force: true });
    });

    it('only one of them holds the lock at a time', async () => {
      const WAITERS = 6;
      const ROUNDS = 8;
      const lock = join(dir, 'data.json.lock');
      const outs: string[] = [];
      const exits: Promise<void>[] = [];
      for (let i = 0; i < WAITERS; i++) {
        const child = spawn(
          process.execPath,
          [LOCK_CHILD, lockModule, dir, `w${i}`, String(ROUNDS)],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        children.push(child);
        outs.push('');
        let err = '';
        child.stdout!.on('data', (d: Buffer) => (outs[i] += d.toString()));
        child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
        exits.push(
          new Promise<void>((resolve, reject) =>
            child.on('exit', (c) =>
              c === 0 ? resolve() : reject(new Error(`waiter w${i} exited ${c}: ${err}`)),
            ),
          ),
        );
      }
      const failed = Promise.race(exits.map((e) => e.then(() => new Promise<never>(() => {}))));
      const allReady = async (round: number) => {
        while (!outs.every((o) => o.includes(`ready ${round}\n`))) {
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      for (let round = 0; round < ROUNDS; round++) {
        await Promise.race([allReady(round), failed]);
        // Every waiter finds a lock left over from a crash and tries to take it over.
        await writeFile(lock, 'crashed');
        const old = new Date(Date.now() - 60_000);
        await utimes(lock, old, old);
        await writeFile(join(dir, `go-${round}`), '');
      }
      await Promise.all(exits);

      const lines = (await readFile(join(dir, 'log'), 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(WAITERS * ROUNDS * 2);
      // Strictly enter/leave pairs of one waiter: no second waiter ever entered
      // while another was inside.
      for (let i = 0; i < lines.length; i += 2) {
        const who = lines[i]!.replace(/^enter /, '');
        expect(lines[i]).toBe(`enter ${who}`);
        expect(lines[i + 1]).toBe(`leave ${who}`);
      }
      expect(existsSync(lock)).toBe(false);
      expect(
        readdirSync(dir).filter((f) => f.includes('.stale-') || f.endsWith('.takeover')),
      ).toEqual([]);
    }, 120_000);
  });
});
