#!/usr/bin/env node
// Checks what each publishable package would put in its npm tarball, without publishing:
// `npm pack --dry-run --json` per package, then asserts
//   - every file named by exports / main / module / types / bin is in the tarball,
//   - README.md and LICENSE are in it,
//   - test/ and src/ are not (unless an export points there),
//   - package.json carries publishConfig { access: public, provenance: true }, repository,
//     homepage, bugs and license, and every exported JS entry has a matching types entry.
// Run it after `pnpm build` (the dist files must exist):
//
//   node scripts/check-pack.mjs [package-dir ...]     (default: the five published packages)
//
// Zero dependencies. Exit code 1 and one line per problem when anything is wrong.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLISHABLE = ['core', 'proxy', 'electron', 'react', 'cli'].map((p) =>
  join(ROOT, 'packages', p),
);

const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Every file path a package.json names as an entry point. */
export function entryFiles(pkg) {
  const files = new Set();
  const add = (v) => {
    if (typeof v === 'string') files.add(norm(v));
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  add(pkg.main);
  add(pkg.module);
  add(pkg.types);
  add(pkg.typings);
  add(pkg.bin);
  add(pkg.exports);
  return [...files].filter((f) => !f.includes('*'));
}

/** Problems with the package.json fields that matter on npm. */
export function manifestProblems(pkg) {
  const problems = [];
  if (pkg.private) problems.push('is private');
  if (pkg.publishConfig?.access !== 'public') problems.push('publishConfig.access is not "public"');
  if (pkg.publishConfig?.provenance !== true) problems.push('publishConfig.provenance is not true');
  if (!pkg.repository?.url || !pkg.repository?.directory) {
    problems.push('repository needs url and directory');
  }
  if (!pkg.homepage) problems.push('homepage is missing');
  if (!pkg.bugs) problems.push('bugs is missing');
  if (!pkg.license) problems.push('license is missing');
  if (!pkg.files?.includes('LICENSE')) problems.push('files does not list LICENSE');
  if (!pkg.files?.includes('README.md')) problems.push('files does not list README.md');
  // Each exported JS entry (other than plain assets like CSS) must say where its types are.
  const walk = (key, value) => {
    if (typeof value === 'string') return;
    if (!value || typeof value !== 'object') return;
    const conditions = Object.keys(value);
    if (conditions.some((c) => ['import', 'require', 'default'].includes(c))) {
      for (const c of ['import', 'require']) {
        const branch = value[c];
        if (branch === undefined) continue;
        const types = typeof branch === 'object' ? branch.types : value.types;
        if (!types) problems.push(`exports["${key}"].${c} has no types`);
        const target = typeof branch === 'object' ? branch.default : branch;
        if (types && c === 'require' && /\.cjs$/.test(target ?? '') && !/\.d\.cts$/.test(types)) {
          problems.push(
            `exports["${key}"].require points at CommonJS but its types are not .d.cts`,
          );
        }
      }
    }
  };
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const [key, value] of Object.entries(pkg.exports)) walk(key, value);
  }
  return problems;
}

/** Problems with the tarball's file list. */
export function tarballProblems(pkg, packedPaths) {
  const problems = [];
  const packed = new Set(packedPaths.map(norm));
  const entries = entryFiles(pkg);
  for (const f of entries) if (!packed.has(f)) problems.push(`tarball is missing ${f}`);
  for (const f of ['README.md', 'LICENSE', 'package.json']) {
    if (!packed.has(f)) problems.push(`tarball is missing ${f}`);
  }
  for (const f of packed) {
    if (/^(test|tests|__tests__)\//.test(f)) problems.push(`tarball includes test file ${f}`);
    if (/^src\//.test(f) && !entries.includes(f)) problems.push(`tarball includes source ${f}`);
  }
  return problems;
}

export function npmPackDryRun(dir) {
  const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: dir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  if (res.status !== 0) {
    throw new Error(`npm pack failed in ${dir}: ${(res.stderr || res.stdout || '').trim()}`);
  }
  const start = res.stdout.indexOf('[');
  const parsed = JSON.parse(res.stdout.slice(start));
  return parsed[0].files.map((f) => f.path);
}

export function checkPackage(dir) {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return { name: dir, problems: [`no package.json in ${dir}`] };
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [...manifestProblems(pkg), ...tarballProblems(pkg, npmPackDryRun(dir))];
  return { name: pkg.name ?? dir, problems };
}

function main(argv) {
  const dirs = argv.length ? argv.map((d) => resolve(d)) : PUBLISHABLE;
  let failed = false;
  for (const dir of dirs) {
    const { name, problems } = checkPackage(dir);
    if (problems.length) {
      failed = true;
      for (const p of problems) console.error(`check-pack: ${name}: ${p}`);
    } else {
      console.log(`check-pack: ${name}: ok`);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`check-pack: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
