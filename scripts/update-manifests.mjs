#!/usr/bin/env node
// Fills a tray release's version, download URLs and SHA-256 hashes into the winget manifests
// (packaging/winget/) and the Homebrew cask (packaging/homebrew/iron-proxy.rb).
//
//   node scripts/update-manifests.mjs <version> <path-to-SHA256SUMS.txt> [--root <dir>]
//
// SHA256SUMS.txt is the file the tray-release workflow attaches to the GitHub Release
// (`sha256sum` output: "<hash>  <file>" per line). Running it twice with the same input changes
// nothing; running it with a newer version replaces the older one. Zero dependencies.
// --root points at a directory holding packaging/ (default: this repository), for tests.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'RealDealCPA-VR/Iron-Proxy';
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function releaseUrl(version, file) {
  return `https://github.com/${REPO}/releases/download/tray-v${version}/${file}`;
}

/** The installer file names the tray-release workflow produces for a version. */
export function installerFiles(version) {
  return {
    winX64: `Iron-Proxy-Setup-${version}-x64.exe`,
    winArm64: `Iron-Proxy-Setup-${version}-arm64.exe`,
    macArm64: `Iron-Proxy-${version}-arm64.dmg`,
    macX64: `Iron-Proxy-${version}-x64.dmg`,
  };
}

/** Parses `sha256sum` / `shasum -a 256` output into Map<fileName, lowercase hash>. */
export function parseSums(text) {
  const sums = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) throw new Error(`Unreadable SHA256SUMS line: ${line}`);
    const name = m[2].trim().split('/').pop();
    sums.set(name, m[1].toLowerCase());
  }
  return sums;
}

function need(sums, file) {
  const hash = sums.get(file);
  if (!hash) throw new Error(`SHA256SUMS.txt has no entry for ${file}`);
  return hash;
}

function replaceOnce(text, re, replacement, what) {
  if (!re.test(text)) throw new Error(`Could not find ${what}`);
  return text.replace(re, replacement);
}

export function updateWingetVersion(text, version) {
  return replaceOnce(text, /^PackageVersion:.*$/m, `PackageVersion: ${version}`, 'PackageVersion');
}

export function updateWingetInstaller(text, version, sums) {
  const files = installerFiles(version);
  const byArch = {
    x64: { url: releaseUrl(version, files.winX64), sha: need(sums, files.winX64) },
    arm64: { url: releaseUrl(version, files.winArm64), sha: need(sums, files.winArm64) },
  };
  let out = updateWingetVersion(text, version);
  const seen = new Set();
  let arch = null;
  out = out
    .split('\n')
    .map((line) => {
      const a = /^\s*-\s*Architecture:\s*(\S+)/.exec(line);
      if (a) {
        arch = a[1];
        if (!byArch[arch]) throw new Error(`Unexpected installer architecture ${arch}`);
        seen.add(arch);
        return line;
      }
      const u = /^(\s*)InstallerUrl:/.exec(line);
      if (u && arch) return `${u[1]}InstallerUrl: ${byArch[arch].url}`;
      const s = /^(\s*)InstallerSha256:/.exec(line);
      if (s && arch) return `${s[1]}InstallerSha256: ${byArch[arch].sha.toUpperCase()}`;
      return line;
    })
    .join('\n');
  for (const a of Object.keys(byArch)) {
    if (!seen.has(a)) throw new Error(`The installer manifest has no ${a} installer`);
  }
  return out;
}

export function updateWingetLocale(text, version) {
  let out = updateWingetVersion(text, version);
  out = replaceOnce(
    out,
    /^ReleaseNotesUrl:.*$/m,
    `ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/tray-v${version}`,
    'ReleaseNotesUrl',
  );
  return out;
}

export function updateCask(text, version, sums) {
  const files = installerFiles(version);
  let out = replaceOnce(text, /^(\s*)version ".*"$/m, `$1version "${version}"`, 'cask version');
  for (const [block, file] of [
    ['on_arm', files.macArm64],
    ['on_intel', files.macX64],
  ]) {
    const re = new RegExp(`(^\\s*${block} do\\n)([\\s\\S]*?)(^\\s*end$)`, 'm');
    const m = re.exec(out);
    if (!m) throw new Error(`The cask has no ${block} block`);
    let body = m[2];
    body = replaceOnce(
      body,
      /^(\s*)url ".*"$/m,
      `$1url "${releaseUrl(version, file)}"`,
      `${block} url`,
    );
    body = replaceOnce(
      body,
      /^(\s*)sha256 ".*"$/m,
      `$1sha256 "${need(sums, file)}"`,
      `${block} sha256`,
    );
    out = out.slice(0, m.index) + m[1] + body + m[3] + out.slice(m.index + m[0].length);
  }
  return out;
}

export function updateManifests({ root, version, sumsText }) {
  if (!VERSION_RE.test(version)) throw new Error(`Not a version: ${version}`);
  const sums = parseSums(sumsText);
  const winget = join(root, 'packaging', 'winget');
  const targets = [
    [join(winget, 'RealDealCPA.IronProxy.yaml'), (t) => updateWingetVersion(t, version)],
    [
      join(winget, 'RealDealCPA.IronProxy.installer.yaml'),
      (t) => updateWingetInstaller(t, version, sums),
    ],
    [
      join(winget, 'RealDealCPA.IronProxy.locale.en-US.yaml'),
      (t) => updateWingetLocale(t, version),
    ],
    [join(root, 'packaging', 'homebrew', 'iron-proxy.rb'), (t) => updateCask(t, version, sums)],
  ];
  // Compute everything first so a bad input leaves every file untouched.
  const results = targets.map(([file, update]) => {
    const before = readFileSync(file, 'utf8');
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    const after = update(before.replace(/\r\n/g, '\n')).replace(/\n/g, eol);
    return { file, before, after };
  });
  const changed = [];
  for (const r of results) {
    if (r.after !== r.before) {
      writeFileSync(r.file, r.after);
      changed.push(r.file);
    }
  }
  return changed;
}

function main(argv) {
  const args = [...argv];
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const at = args.indexOf('--root');
  if (at !== -1) {
    const dir = args[at + 1];
    if (!dir) throw new Error('--root needs a directory');
    root = resolve(dir);
    args.splice(at, 2);
  }
  const [version, sumsPath] = args;
  if (!version || !sumsPath || args.length !== 2) {
    throw new Error(
      'Usage: node scripts/update-manifests.mjs <version> <SHA256SUMS.txt> [--root <dir>]',
    );
  }
  const changed = updateManifests({
    root,
    version: version.replace(/^tray-v/, ''),
    sumsText: readFileSync(sumsPath, 'utf8'),
  });
  console.log(
    changed.length
      ? `Updated ${changed.length} manifest(s) for ${version}:\n${changed.map((f) => `  ${f}`).join('\n')}`
      : `Manifests already up to date for ${version}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`update-manifests: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
