import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baseUrls,
  decideProxy,
  isPidAlive,
  parseDescriptor,
  PROXY_DESCRIPTOR_FILE,
  readDescriptor,
  removeDescriptorIfOwned,
  writeDescriptor,
  type ProxyDescriptor,
} from '../src/logic/proxy.js';

const other: ProxyDescriptor = { url: 'http://127.0.0.1:8791', token: 't', pid: 4242 };

describe('decideProxy', () => {
  it('starts a proxy when there is no descriptor', () => {
    expect(decideProxy(undefined, () => true, 1)).toEqual({ action: 'start', stale: false });
  });

  it('reuses a proxy whose process is still running', () => {
    const asked: number[] = [];
    const d = decideProxy(
      other,
      (pid) => {
        asked.push(pid);
        return true;
      },
      1,
    );
    expect(d).toEqual({ action: 'reuse', descriptor: other });
    expect(asked).toEqual([4242]);
  });

  it('starts its own when the descriptor is stale', () => {
    expect(decideProxy(other, () => false, 1)).toEqual({ action: 'start', stale: true });
  });

  it('treats a descriptor naming this very process as stale', () => {
    expect(decideProxy({ ...other, pid: 7 }, () => true, 7)).toEqual({
      action: 'start',
      stale: true,
    });
  });
});

describe('isPidAlive', () => {
  it('is true for this process and false for ESRCH, true for EPERM', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    const throwing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(isPidAlive(123, throwing('ESRCH'))).toBe(false);
    expect(isPidAlive(123, throwing('EPERM'))).toBe(true);
    const calls: Array<[number, number]> = [];
    isPidAlive(55, (pid, sig) => calls.push([pid, sig]));
    expect(calls).toEqual([[55, 0]]);
  });
});

describe('proxy.json', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'iron-tray-proxy-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the same shape the CLI serve writes and reads it back', async () => {
    await writeDescriptor(dir, other);
    expect(JSON.parse(await readFile(join(dir, PROXY_DESCRIPTOR_FILE), 'utf8'))).toEqual(other);
    expect(await readDescriptor(dir)).toEqual(other);
  });

  it('reads nothing from a missing, damaged or wrong-shaped file', async () => {
    expect(await readDescriptor(dir)).toBeUndefined();
    await writeFile(join(dir, PROXY_DESCRIPTOR_FILE), '{');
    expect(await readDescriptor(dir)).toBeUndefined();
    await writeFile(join(dir, PROXY_DESCRIPTOR_FILE), JSON.stringify({ url: 'x', pid: 'a' }));
    expect(await readDescriptor(dir)).toBeUndefined();
    expect(parseDescriptor({ url: 'http://h', token: 't', pid: 0 })).toBeUndefined();
  });

  it("removes the file only while it names this process, never another process's", async () => {
    await writeDescriptor(dir, other);
    expect(await removeDescriptorIfOwned(dir, 1)).toBe(false);
    expect(await readDescriptor(dir)).toEqual(other);
    expect(await removeDescriptorIfOwned(dir, 4242)).toBe(true);
    expect(await readDescriptor(dir)).toBeUndefined();
    expect(await removeDescriptorIfOwned(dir, 4242)).toBe(false);
  });
});

describe('baseUrls', () => {
  it('gives the OpenAI base with /v1 and the Anthropic base without', () => {
    expect(baseUrls('http://127.0.0.1:8791/')).toEqual({
      openai: 'http://127.0.0.1:8791/v1',
      anthropic: 'http://127.0.0.1:8791',
    });
  });
});
