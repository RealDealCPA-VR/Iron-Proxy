import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIronProxy,
  MemoryProfileStore,
  MemoryStateStore,
  MemoryVault,
  type IronProxy,
} from '@iron-proxy/core';
import { runCli, type CliIo } from '../src/index.js';

const frame = (data: unknown) => `event: x\ndata: ${JSON.stringify(data)}\n\n`;

/** A fake Anthropic API: key-A is cut off mid-answer by a rate limit, key-B finishes. */
function fakeAnthropic(bodies: Array<{ key: string; body: { messages: unknown[] } }>) {
  return (async (_input: unknown, init?: RequestInit) => {
    const key = new Headers(init?.headers as HeadersInit).get('x-api-key') ?? '';
    const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
    bodies.push({ key, body });
    const delta = (text: string) =>
      frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    const frames = [
      frame({
        type: 'message_start',
        message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-x', content: [] },
      }),
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...(key === 'key-A'
        ? [
            delta('The first half, '),
            frame({ type: 'error', error: { type: 'rate_limit_error', message: 'limited' } }),
          ]
        : [
            delta('and the second half.'),
            frame({ type: 'content_block_stop', index: 0 }),
            frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }),
            frame({ type: 'message_stop' }),
          ]),
    ];
    return new Response(new Blob(frames).stream(), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

let dir: string;
let iron: IronProxy;
let bodies: Array<{ key: string; body: { messages: unknown[] } }>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-cli-resume-'));
  bodies = [];
  iron = createIronProxy({
    dataDir: dir,
    profiles: new MemoryProfileStore(),
    states: new MemoryStateStore(),
    vault: new MemoryVault(),
    fetch: fakeAnthropic(bodies),
    policy: { overloadRetries: 0 },
  });
  await iron.createProfile({
    title: 'First',
    provider: 'anthropic',
    lane: 'api-key',
    apiKeySecret: 'key-A',
  });
  await iron.createProfile({
    title: 'Second',
    provider: 'anthropic',
    lane: 'api-key',
    apiKeySecret: 'key-B',
  });
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

function io() {
  let out = '';
  let err = '';
  const o: CliIo = {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    iron,
    env: { IRON_PROXY_DATA_DIR: dir },
  };
  return { io: o, out: () => out, err: () => err };
}

describe('chat --resume', () => {
  it('continues a cut-off answer on the next account and says so on stderr', async () => {
    const [a, b] = await iron.listProfiles('anthropic');
    const r = io();
    expect(await runCli(['chat', 'anthropic', '--resume', 'tell me'], r.io)).toBe(0);
    expect(r.out()).toBe('The first half, and the second half.\n');
    expect(r.err()).toContain(`[iron] switched ${a!.id} -> ${b!.id} (rate-limit, resumed)`);
    expect(r.err()).toContain('served by "Second"');
    expect(bodies.map((x) => x.key)).toEqual(['key-A', 'key-B']);
    expect(bodies[1]!.body.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'The first half,' }],
    });
  });

  it('without --resume the cut surfaces STREAM_INTERRUPTED, as before', async () => {
    const r = io();
    expect(await runCli(['chat', 'anthropic', 'tell me'], r.io)).toBe(1);
    expect(r.out()).toBe('The first half, \n');
    expect(r.err()).toContain('STREAM_INTERRUPTED');
    expect(bodies.map((x) => x.key)).toEqual(['key-A']);
  });
});
