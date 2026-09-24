import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIronProxy,
  MemoryProfileStore,
  MemoryStateStore,
  MemoryUsageStore,
  MemoryVault,
  type IronProxy,
} from '@iron-proxy/core';
import { runCli, type CliIo } from '../src/index.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let iron: IronProxy;
let usage: MemoryUsageStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-cli-usage-'));
  const clock = { now: () => T0 };
  usage = new MemoryUsageStore({ clock });
  iron = createIronProxy({
    dataDir: dir,
    profiles: new MemoryProfileStore(),
    states: new MemoryStateStore(),
    vault: new MemoryVault(),
    usage,
    clock,
  });
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

function io(): { io: CliIo; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      iron,
      env: { IRON_PROXY_DATA_DIR: dir },
    },
    out: () => out,
    err: () => err,
  };
}

async function seed() {
  const work = await iron.createProfile({
    title: 'Work Claude',
    provider: 'anthropic',
    lane: 'api-key',
  });
  const home = await iron.createProfile({
    title: 'Home Codex',
    provider: 'openai',
    lane: 'api-key',
  });
  const reset = iso(T0 + 3 * HOUR);
  for (let i = 0; i < 3; i++)
    await usage.addRequest(work.id, {
      at: iso(T0 - (i + 1) * HOUR),
      durationMs: 10,
      inputTokens: 1000,
      outputTokens: 500,
    });
  await usage.addRequest(work.id, { at: iso(T0 - 30 * HOUR), durationMs: 10, inputTokens: 200 });
  await usage.addPark(work.id, { at: iso(T0 - 2 * HOUR), kind: 'rate-limit' });
  // 0.2 -> 0.3 -> 0.4 over ten minutes: 30 minutes left, low confidence.
  await usage.addSample(work.id, { at: iso(T0 - 10 * MIN), utilisation: 0.2, resetAt: reset });
  await usage.addSample(work.id, { at: iso(T0 - 5 * MIN), utilisation: 0.3, resetAt: reset });
  await usage.addSample(work.id, { at: iso(T0), utilisation: 0.4, resetAt: reset });
  return { work, home };
}

describe('iron-proxy usage', () => {
  it('prints a table with windows, parks this week and the pace estimate', async () => {
    await seed();
    const h = io();
    expect(await runCli(['usage'], h.io)).toBe(0);
    const text = h.out();
    const lines = text.trim().split('\n');
    expect(lines[0]).toMatch(/title\s+provider\s+5h\s+24h\s+7d\s+parks this week\s+pace/);
    const work = lines.find((l) => l.startsWith('Work Claude'))!;
    expect(work).toContain('anthropic');
    expect(work).toContain('3 req, 4.5k tok'); // 5h and 24h
    expect(work).toContain('4 req, 4.7k tok'); // 7d
    expect(work).toContain('about 30 min left at this pace (rough)');
    expect(work).toMatch(/tok\s+1\s+about/); // one park this week
    const home = lines.find((l) => l.startsWith('Home Codex'))!;
    expect(home).toContain('0 req, 0 tok');
    expect(home).not.toContain('left at this pace');
    expect(h.err()).toBe('');
  });

  it('--json prints the reports, --profile narrows to one account', async () => {
    const { work, home } = await seed();
    const j = io();
    expect(await runCli(['usage', '--json'], j.io)).toBe(0);
    const reports = JSON.parse(j.out()) as Array<{ profileId: string; estimate?: unknown }>;
    expect(reports.map((r) => r.profileId)).toEqual([work.id, home.id]);
    expect(reports[0]?.estimate).toEqual({
      minutesLeft: 30,
      basis: 'utilisation-trend',
      confidence: 'low',
    });
    const one = io();
    expect(await runCli(['usage', '--profile', home.id, '--json'], one.io)).toBe(0);
    expect((JSON.parse(one.out()) as Array<{ profileId: string }>).map((r) => r.profileId)).toEqual(
      [home.id],
    );
    const bad = io();
    expect(await runCli(['usage', '--profile', 'nope'], bad.io)).toBe(1);
    expect(bad.err()).toContain('PROFILE_NOT_FOUND');
  });

  it('says so when there are no accounts, and is listed in the help', async () => {
    const h = io();
    expect(await runCli(['usage'], h.io)).toBe(0);
    expect(h.out()).toContain('No accounts yet');
    const help = io();
    await runCli(['--help'], help.io);
    expect(help.out()).toContain('iron-proxy usage [--json] [--profile id]');
  });
});
