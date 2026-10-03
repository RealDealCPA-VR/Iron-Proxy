import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The single-file bundle (`pnpm --filter iron-proxy bundle`) is what hosts ship
 * inside their own app and run with their own Node, or with Electron as Node. This
 * builds it with the real bundle config into a temp dir and runs it: one ESM file,
 * no @iron-proxy/* import left, `--version`, and `serve --port 0` writing proxy.json.
 */

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
const TSUP_CLI = join(
  dirname(createRequire(import.meta.url).resolve('tsup/package.json')),
  'dist',
  'cli-default.js',
);

let out: string;
let bundle: string;

function run(args: string[], cwd = PKG_DIR): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve({ code, stdout }) : reject(new Error(`exit ${code}: ${stderr}`)),
    );
  });
}

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'iron-bundle-test-'));
  await run([TSUP_CLI, '--config', 'tsup.bundle.config.ts', '--out-dir', out]);
  bundle = join(out, 'iron-proxy.mjs');
}, 120_000);
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe('single-file bundle', () => {
  it('is one ESM file that imports only Node built-ins', async () => {
    const src = await readFile(bundle, 'utf8');
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true);
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((s) => s?.startsWith('@iron-proxy/'))).toEqual([]);
    expect(src).not.toMatch(/from ["']@iron-proxy\//);
    expect(src).not.toMatch(/import\(["']\.\/chunk/);
  });

  it('prints the package version', async () => {
    const pkg = JSON.parse(await readFile(join(PKG_DIR, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect((await run([bundle, '--version'])).stdout.trim()).toBe(pkg.version);
  });

  it('serve --port 0 --data-dir <missing dir> creates it, writes proxy.json and answers', async () => {
    const dataDir = join(out, 'not-yet', 'data');
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, [bundle, 'serve', '--port', '0', '--data-dir', dataDir], {
        stdio: 'ignore',
      });
      let desc: { url: string; token: string; pid: number } | undefined;
      for (let i = 0; i < 300 && !desc; i++) {
        desc = await readFile(join(dataDir, 'proxy.json'), 'utf8')
          .then((t) => JSON.parse(t) as { url: string; token: string; pid: number })
          .catch(() => undefined);
        if (!desc) await new Promise((r) => setTimeout(r, 50));
      }
      expect(desc?.pid).toBe(child.pid);
      const res = await fetch(`${desc!.url}/iron/pick?provider=anthropic`, {
        headers: { authorization: `Bearer ${desc!.token}` },
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { iron: { code: string } }).iron.code).toBe('NO_PROFILE');
    } finally {
      child?.kill();
    }
  });
});
