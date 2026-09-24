import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `<dataDir>/proxy.json`: the descriptor `iron-proxy serve` writes, in the same
 * shape, so the CLI, the tray and any other tool find the one running proxy.
 */
export interface ProxyDescriptor {
  url: string;
  token: string;
  pid: number;
}

export const PROXY_DESCRIPTOR_FILE = 'proxy.json';

export type ProxyDecision =
  { action: 'reuse'; descriptor: ProxyDescriptor } | { action: 'start'; stale: boolean };

export function parseDescriptor(raw: unknown): ProxyDescriptor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) return undefined;
  if (typeof r.token !== 'string') return undefined;
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return undefined;
  return { url: r.url, token: r.token, pid: r.pid };
}

/**
 * Reuse a proxy another process (the CLI's `serve`, or another tray) is already
 * running for this data directory, or start one. A descriptor whose process is
 * gone, or that names this very process, is stale.
 */
export function decideProxy(
  existing: ProxyDescriptor | undefined,
  isAlive: (pid: number) => boolean,
  selfPid: number = process.pid,
): ProxyDecision {
  if (!existing) return { action: 'start', stale: false };
  if (existing.pid !== selfPid && isAlive(existing.pid))
    return { action: 'reuse', descriptor: existing };
  return { action: 'start', stale: true };
}

/** `process.kill(pid, 0)`: true when the process exists (EPERM: it exists but is not ours). */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => unknown = (p, s) => process.kill(p, s),
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readDescriptor(dataDir: string): Promise<ProxyDescriptor | undefined> {
  try {
    return parseDescriptor(
      JSON.parse(await readFile(join(dataDir, PROXY_DESCRIPTOR_FILE), 'utf8')),
    );
  } catch {
    return undefined;
  }
}

export async function writeDescriptor(dataDir: string, d: ProxyDescriptor): Promise<void> {
  await writeFile(join(dataDir, PROXY_DESCRIPTOR_FILE), JSON.stringify(d, null, 2), {
    mode: 0o600,
  });
}

/** Remove proxy.json only while it still names `pid`: never another process's descriptor. */
export async function removeDescriptorIfOwned(dataDir: string, pid: number): Promise<boolean> {
  const d = await readDescriptor(dataDir);
  if (!d || d.pid !== pid) return false;
  await rm(join(dataDir, PROXY_DESCRIPTOR_FILE), { force: true });
  return true;
}

export { baseUrls } from './shared.js';
