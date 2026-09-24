import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIronProxy,
  MemoryProfileStore,
  MemoryStateStore,
  MemoryVault,
  type IronProxy,
  type IronProxyOptions,
} from '@iron-proxy/core';
import { createProxyServer, type ProxyServer } from '../src/index.js';

export interface FakeUpstream {
  fetch: typeof fetch;
  calls: Array<{ url: string; key: string | null; stream: boolean }>;
  /** Keys that should 429 on their next call (consumed). */
  exhaustNext: Set<string>;
  /** Keys that always 429 with the given reset. */
  alwaysExhausted: Map<string, string>;
}

/** Fake Anthropic + OpenAI upstream, keyed on the API key so tests can see which account served. */
export function fakeUpstream(): FakeUpstream {
  const state: FakeUpstream = {
    fetch: undefined as unknown as typeof fetch,
    calls: [],
    exhaustNext: new Set(),
    alwaysExhausted: new Map(),
  };
  state.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers as HeadersInit);
    const key =
      headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      stream?: boolean;
      messages?: Array<{ content: unknown }>;
    };
    const stream = !!body.stream;
    state.calls.push({ url, key, stream });
    const isAnthropic = url.includes('/messages');

    const reset =
      (key && state.alwaysExhausted.get(key)) ||
      (key && state.exhaustNext.has(key)
        ? new Date(Date.now() + 3_600_000).toISOString()
        : undefined);
    if (reset) {
      if (key) state.exhaustNext.delete(key);
      return new Response(
        isAnthropic
          ? '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}'
          : '{"error":{"code":"rate_limit_exceeded","message":"limited"}}',
        {
          status: 429,
          headers: isAnthropic
            ? { 'anthropic-ratelimit-requests-reset': reset }
            : { 'x-ratelimit-reset-requests': '1h' },
        },
      );
    }

    const text = `served by ${key}`;
    if (isAnthropic) {
      if (!stream) {
        return json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-x',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 },
        });
      }
      const frames = [
        ev('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-x',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        }),
        ev('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'served ' },
        }),
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `by ${key}` },
        }),
        ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
        ev('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        }),
        ev('message_stop', { type: 'message_stop' }),
      ];
      return sse(frames);
    }
    if (!stream) {
      return json({
        id: 'chatcmpl_1',
        model: 'gpt-x',
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      });
    }
    const chunks = [
      {
        id: 'chatcmpl_1',
        model: 'gpt-x',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'served ' }, finish_reason: null },
        ],
      },
      {
        id: 'chatcmpl_1',
        model: 'gpt-x',
        choices: [{ index: 0, delta: { content: `by ${key}` }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_1',
        model: 'gpt-x',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'chatcmpl_1',
        model: 'gpt-x',
        choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    ];
    return sse([...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n']);
  };
  return state;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
function ev(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
function sse(frames: string[]): Response {
  return new Response(new Blob(frames).stream(), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export interface Harness {
  iron: IronProxy;
  upstream: FakeUpstream;
  proxy: ProxyServer;
  url: string;
  token: string;
  dir: string;
  close(): Promise<void>;
}

export async function harness(
  opts: {
    cors?: boolean;
    requireAuthForModels?: boolean;
    /** Extra manager options, e.g. a registry with fake vendor CLIs and an env. */
    ironOpts?: Pick<IronProxyOptions, 'registry' | 'env'>;
  } = {},
): Promise<Harness> {
  const { ironOpts, ...proxyOpts } = opts;
  const upstream = fakeUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'iron-proxy-test-'));
  const iron = createIronProxy({
    dataDir: dir,
    profiles: new MemoryProfileStore(),
    states: new MemoryStateStore(),
    vault: new MemoryVault(),
    fetch: upstream.fetch,
    policy: { overloadRetries: 0 },
    ...(ironOpts ?? {}),
  });
  const proxy = createProxyServer({ iron, port: 0, heartbeatMs: 200, ...proxyOpts });
  const { url, token } = await proxy.listen();
  return {
    iron,
    upstream,
    proxy,
    url,
    token,
    dir,
    close: async () => {
      await proxy.close();
      await iron.close();
    },
  };
}

/** Collect raw SSE frames from a Response body. */
export async function readSse(
  res: Response,
): Promise<{ comments: string[]; frames: Array<{ event?: string; data: string }> }> {
  const text = await res.text();
  const comments: string[] = [];
  const frames: Array<{ event?: string; data: string }> = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) comments.push(line.slice(1).trim());
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length) frames.push({ ...(event ? { event } : {}), data: data.join('\n') });
  }
  return { comments, frames };
}
