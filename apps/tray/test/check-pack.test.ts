// scripts/check-pack.mjs run as a real child process (it runs the real `npm pack --dry-run`)
// against small throwaway packages, so a regression in the checker itself shows up here.
// `pnpm pack:check` (part of `pnpm check`) runs it against the five published packages.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/check-pack.mjs', import.meta.url));

let dir: string;

function goodManifest(): Record<string, unknown> {
  return {
    name: '@iron-proxy/fixture',
    version: '1.0.0',
    license: 'MIT',
    type: 'module',
    main: './dist/index.cjs',
    types: './dist/index.d.ts',
    exports: {
      '.': {
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
        require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
      },
    },
    files: ['dist', 'README.md', 'LICENSE'],
    repository: { type: 'git', url: 'https://example.invalid/x.git', directory: 'packages/x' },
    homepage: 'https://example.invalid/x',
    bugs: { url: 'https://example.invalid/x/issues' },
    publishConfig: { access: 'public', provenance: true },
  };
}

function write(
  pkg: Record<string, unknown>,
  extra: Record<string, string> = {},
  omit: readonly string[] = [],
): void {
  const all: Record<string, string> = {
    'package.json': JSON.stringify(pkg, null, 2),
    'README.md': '# fixture\n',
    LICENSE: 'MIT\n',
    'dist/index.js': 'export const x = 1;\n',
    'dist/index.cjs': 'exports.x = 1;\n',
    'dist/index.d.ts': 'export declare const x: number;\n',
    'dist/index.d.cts': 'export declare const x: number;\n',
    ...extra,
  };
  for (const [file, text] of Object.entries(all)) {
    if (omit.includes(file)) continue;
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

function check(): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iron-pack-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('check-pack', () => {
  it('passes a package whose tarball has its entry files, README and LICENSE', () => {
    write(goodManifest());
    const res = check();
    expect(res.out).toContain('@iron-proxy/fixture: ok');
    expect(res.status).toBe(0);
  });

  it('fails when LICENSE, README or an exported file would be missing from the tarball', () => {
    const pkg = goodManifest();
    pkg.files = ['dist/index.js', 'dist/index.d.ts'];
    write(pkg);
    const res = check();
    expect(res.status).toBe(1);
    expect(res.out).toContain('files does not list LICENSE');
    expect(res.out).toContain('tarball is missing dist/index.cjs');
    expect(res.out).toContain('tarball is missing dist/index.d.cts');
  });

  it('fails when the package has no LICENSE file, even though files lists it', () => {
    write(goodManifest(), {}, ['LICENSE']);
    const res = check();
    expect(res.status).toBe(1);
    expect(res.out).toContain('tarball is missing LICENSE');
    expect(res.out).not.toContain('files does not list LICENSE');
    expect(res.out).not.toContain('@iron-proxy/fixture: ok');
  });

  it('fails when the package has no README.md file, even though files lists it', () => {
    write(goodManifest(), {}, ['README.md']);
    const res = check();
    expect(res.status).toBe(1);
    expect(res.out).toContain('tarball is missing README.md');
    expect(res.out).not.toContain('files does not list README.md');
    expect(res.out).not.toContain('@iron-proxy/fixture: ok');
  });

  it('fails when tests or sources would be published', () => {
    const pkg = goodManifest();
    pkg.files = ['dist', 'README.md', 'LICENSE', 'src', 'test'];
    write(pkg, { 'src/index.ts': 'export const x = 1;\n', 'test/a.test.ts': '\n' });
    const res = check();
    expect(res.status).toBe(1);
    expect(res.out).toContain('tarball includes source src/index.ts');
    expect(res.out).toContain('tarball includes test file test/a.test.ts');
  });

  it('fails without provenance, repository, homepage or bugs, and on CommonJS typed as ESM', () => {
    const pkg = goodManifest();
    pkg.publishConfig = { access: 'public' };
    delete pkg.homepage;
    delete pkg.bugs;
    delete pkg.repository;
    pkg.exports = {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
        require: { types: './dist/index.d.ts', default: './dist/index.cjs' },
      },
    };
    write(pkg);
    const res = check();
    expect(res.status).toBe(1);
    expect(res.out).toContain('publishConfig.provenance is not true');
    expect(res.out).toContain('homepage is missing');
    expect(res.out).toContain('bugs is missing');
    expect(res.out).toContain('repository needs url and directory');
    expect(res.out).toContain('require points at CommonJS but its types are not .d.cts');
  });
});
