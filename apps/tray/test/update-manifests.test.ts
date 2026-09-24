// scripts/update-manifests.mjs run as a real child process against a copy of packaging/.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const script = join(repo, 'scripts', 'update-manifests.mjs');
const fixture = fileURLToPath(new URL('./fixtures/SHA256SUMS.txt', import.meta.url));
const base = 'https://github.com/RealDealCPA-VR/Iron-Proxy/releases/download';

let root: string;
const files = {
  version: 'packaging/winget/RealDealCPA.IronProxy.yaml',
  installer: 'packaging/winget/RealDealCPA.IronProxy.installer.yaml',
  locale: 'packaging/winget/RealDealCPA.IronProxy.locale.en-US.yaml',
  cask: 'packaging/homebrew/iron-proxy.rb',
};
const read = (f: keyof typeof files): string => readFileSync(join(root, files[f]), 'utf8');
const snapshot = (): string[] => Object.keys(files).map((f) => read(f as keyof typeof files));

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iron-manifests-'));
  cpSync(join(repo, 'packaging'), join(root, 'packaging'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('update-manifests', () => {
  it('the committed manifests carry placeholder hashes, not a real release', () => {
    for (const f of Object.values(files)) {
      const text = readFileSync(join(repo, f), 'utf8');
      expect(text).not.toMatch(/[1-9a-f]{64}/i);
    }
  });

  it('fills version, URLs and hashes into the winget manifests and the cask', () => {
    const res = run('1.2.3', fixture);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Updated 4 manifest(s)');

    expect(read('version')).toMatch(/^PackageVersion: 1\.2\.3$/m);
    expect(read('locale')).toMatch(/^PackageVersion: 1\.2\.3$/m);
    expect(read('locale')).toContain(
      'ReleaseNotesUrl: https://github.com/RealDealCPA-VR/Iron-Proxy/releases/tag/tray-v1.2.3',
    );

    const installer = read('installer');
    expect(installer).toMatch(/^PackageVersion: 1\.2\.3$/m);
    // Each architecture gets its own file and hash (upper case, as winget writes them).
    const x64 = installer.slice(
      installer.indexOf('Architecture: x64'),
      installer.indexOf('Architecture: arm64'),
    );
    const arm = installer.slice(installer.indexOf('Architecture: arm64'));
    expect(x64).toContain(`InstallerUrl: ${base}/tray-v1.2.3/Iron-Proxy-Setup-1.2.3-x64.exe`);
    expect(x64).toContain(`InstallerSha256: ${'1'.repeat(64)}`);
    expect(arm).toContain(`InstallerUrl: ${base}/tray-v1.2.3/Iron-Proxy-Setup-1.2.3-arm64.exe`);
    expect(arm).toContain(`InstallerSha256: ${'2'.repeat(64)}`);
    expect(installer).not.toContain('0.1.0');

    const cask = read('cask');
    expect(cask).toMatch(/^ {2}version "1\.2\.3"$/m);
    const onArm = cask.slice(cask.indexOf('on_arm do'), cask.indexOf('on_intel do'));
    const onIntel = cask.slice(cask.indexOf('on_intel do'), cask.indexOf('name "Iron-Proxy"'));
    expect(onArm).toContain(`url "${base}/tray-v1.2.3/Iron-Proxy-1.2.3-arm64.dmg"`);
    expect(onArm).toContain(`sha256 "${'a'.repeat(64)}"`);
    expect(onIntel).toContain(`url "${base}/tray-v1.2.3/Iron-Proxy-1.2.3-x64.dmg"`);
    expect(onIntel).toContain(`sha256 "${'b'.repeat(64)}"`);
    // Everything else in the cask is left as it was.
    expect(cask).toContain('app "Iron-Proxy.app"');
    expect(cask).not.toContain('~/.iron-proxy"');
  });

  it('is idempotent, and a newer release replaces the older one', () => {
    expect(run('1.2.3', fixture).status).toBe(0);
    const first = snapshot();
    const again = run('tray-v1.2.3', fixture);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('already up to date');
    expect(snapshot()).toEqual(first);

    const next = join(root, 'SUMS-next.txt');
    writeFileSync(next, readFileSync(fixture, 'utf8').replaceAll('1.2.3', '1.3.0'));
    expect(run('1.3.0', next).status).toBe(0);
    expect(read('installer')).toContain(`${base}/tray-v1.3.0/Iron-Proxy-Setup-1.3.0-arm64.exe`);
    expect(read('cask')).toContain(`${base}/tray-v1.3.0/Iron-Proxy-1.3.0-x64.dmg`);
    expect(snapshot().join('\n')).not.toContain('1.2.3');
  });

  it('refuses a release missing an installer and leaves every file untouched', () => {
    const before = snapshot();
    const partial = join(root, 'SUMS-partial.txt');
    writeFileSync(
      partial,
      readFileSync(fixture, 'utf8')
        .split('\n')
        .filter((l) => !l.includes('x64.dmg'))
        .join('\n'),
    );
    const res = run('1.2.3', partial);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no entry for Iron-Proxy-1.2.3-x64.dmg');
    expect(snapshot()).toEqual(before);
  });

  it('refuses a bad version, a bad checksum line and missing arguments', () => {
    expect(run('latest', fixture).stderr).toContain('Not a version: latest');
    const bad = join(root, 'SUMS-bad.txt');
    writeFileSync(bad, 'not-a-hash  Iron-Proxy-Setup-1.2.3-x64.exe\n');
    expect(run('1.2.3', bad).stderr).toContain('Unreadable SHA256SUMS line');
    expect(run('1.2.3').stderr).toContain('Usage:');
  });

  it('keeps CRLF files CRLF', () => {
    const file = join(root, files.cask);
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    execFileSync(process.execPath, [script, '1.2.3', fixture, '--root', root]);
    const text = read('cask');
    expect(text).toContain('version "1.2.3"\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
