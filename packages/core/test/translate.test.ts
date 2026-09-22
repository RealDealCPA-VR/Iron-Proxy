import { describe, expect, it } from 'vitest';
import type { StreamEvent, UnifiedRequest } from '../src/types.js';
import * as oa from '../src/translate/openai.js';
import * as an from '../src/translate/anthropic.js';
import * as gg from '../src/translate/google.js';
import { parseSse, sseFrame } from '../src/translate/sse.js';

const req: UnifiedRequest = {
  model: 'x',
  system: 'Be terse.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is the weather?' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'c1', name: 'weather', arguments: { city: 'Paris' } }],
    },
    { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'c1', content: '{"temp":21}' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Thanks' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      ],
    },
  ],
  tools: [
    {
      name: 'weather',
      description: 'Get weather',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        additionalProperties: false,
      },
    },
  ],
  toolChoice: 'auto',
  maxTokens: 100,
  temperature: 0.2,
  stop: ['END'],
};

describe('OpenAI translation', () => {
  it('round-trips a request', () => {
    const wire = oa.toOpenAIRequest(req, 'gpt-5', true);
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'Be terse.' });
    expect(wire.messages.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'c1' });
    expect(wire.stream_options).toEqual({ include_usage: true });
    expect(wire.max_completion_tokens).toBe(100);
    const back = oa.fromOpenAIRequest(wire);
    expect(back.system).toBe('Be terse.');
    expect(back.messages[1]?.content[0]).toMatchObject({
      type: 'tool_call',
      name: 'weather',
      arguments: { city: 'Paris' },
    });
    expect(back.messages[3]?.content[1]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: 'AAAA',
    });
    expect(back.tools?.[0]?.name).toBe('weather');
  });
  it('maps responses and chunks', () => {
    const res = oa.fromOpenAIResponse({
      id: 'r',
      model: 'gpt-5',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hi',
            tool_calls: [
              { id: 't', type: 'function', function: { name: 'f', arguments: '{"a":1}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    expect(res.finishReason).toBe('tool_calls');
    expect(res.message.content).toHaveLength(2);
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const tr = new oa.OpenAIChunkTranslator({ provider: 'openai', profileId: 'p' });
    const evs = [
      ...tr.translate({
        id: 'r',
        model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }],
      }),
      ...tr.translate({
        id: 'r',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'tc', function: { name: 'f', arguments: '{"a"' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      ...tr.translate({
        id: 'r',
        model: 'm',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      ...tr.translate({
        id: 'r',
        model: 'm',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    ];
    expect(evs.map((e) => e.type)).toEqual([
      'start',
      'text',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_delta',
      'tool_call_end',
      'finish',
      'usage',
    ]);
  });
  it('emits OpenAI chunks from unified events', () => {
    const c = oa.toOpenAIChunk({ type: 'text', delta: 'x' }, 'id', 'm', 1);
    expect(c?.choices[0]?.delta.content).toBe('x');
    expect(
      oa.toOpenAIChunk(
        {
          type: 'switched',
          fromProfileId: 'a',
          toProfileId: 'b',
          reason: { kind: 'rate-limit', source: 'status' },
        },
        'id',
        'm',
        1,
      ),
    ).toBeUndefined();
  });
});

describe('Anthropic translation', () => {
  it('round-trips a request and merges consecutive same-role blocks', () => {
    const wire = an.toAnthropicRequest(req, 'claude-sonnet-5', false);
    expect(wire.system).toBe('Be terse.');
    expect(wire.messages).toHaveLength(3); // user, assistant(tool_use), user(tool_result + text + image)
    expect(wire.messages[2]?.content).toHaveLength(3);
    expect(wire.tools?.[0]?.input_schema).toBeDefined();
    const back = an.fromAnthropicRequest(wire);
    expect(back.messages[1]?.content[0]).toMatchObject({ type: 'tool_call', id: 'c1' });
    expect(back.maxTokens).toBe(100);
  });
  it('translates a stream', () => {
    const tr = new an.AnthropicEventTranslator({ provider: 'anthropic', profileId: 'p' });
    const evs: StreamEvent[] = [
      ...tr.translate({
        type: 'message_start',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          model: 'c',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5 },
        },
      }),
      ...tr.translate({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      ...tr.translate({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hi' },
      }),
      ...tr.translate({ type: 'content_block_stop', index: 0 }),
      ...tr.translate({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu', name: 'f', input: {} },
      }),
      ...tr.translate({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      }),
      ...tr.translate({ type: 'content_block_stop', index: 1 }),
      ...tr.translate({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 7 },
      }),
      ...tr.translate({ type: 'message_stop' }),
    ];
    expect(evs.map((e) => e.type)).toEqual([
      'start',
      'text',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_end',
      'usage',
      'finish',
    ]);
    expect(evs.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 5, outputTokens: 7 },
    });
  });
  it('converts unified events back into Anthropic SSE with block indices', () => {
    const t = new an.ToAnthropicStream();
    const all = [
      ...t.translate(
        { type: 'start', id: 'i', model: 'm', provider: 'anthropic', profileId: 'p' },
        'i',
        'm',
      ),
      ...t.translate({ type: 'text', delta: 'a' }, 'i', 'm'),
      ...t.translate({ type: 'tool_call_start', id: 'tc', name: 'f' }, 'i', 'm'),
      ...t.translate({ type: 'tool_call_delta', id: 'tc', argumentsDelta: '{}' }, 'i', 'm'),
      ...t.translate({ type: 'tool_call_end', id: 'tc' }, 'i', 'm'),
      ...t.translate({ type: 'finish', finishReason: 'tool_calls' }, 'i', 'm'),
    ];
    expect(all.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect((all[4] as { index: number }).index).toBe(1);
  });
});

describe('Gemini translation', () => {
  it('builds contents, strips unsupported schema keys, maps tool results by call name', () => {
    const wire = gg.toGeminiRequest(req);
    expect(wire.systemInstruction?.parts[0]?.text).toBe('Be terse.');
    expect(JSON.stringify(wire.tools)).not.toContain('additionalProperties');
    const fr = wire.contents[2]?.parts.find((p) => 'functionResponse' in p) as {
      functionResponse: { name: string; response: unknown };
    };
    expect(fr.functionResponse.name).toBe('weather');
    expect(fr.functionResponse.response).toEqual({ temp: 21 });
    expect(wire.generationConfig).toMatchObject({
      maxOutputTokens: 100,
      temperature: 0.2,
      stopSequences: ['END'],
    });
  });
  it('maps responses', () => {
    const r = gg.fromGeminiResponse(
      {
        candidates: [
          {
            content: { parts: [{ text: 'ok' }, { functionCall: { name: 'f', args: { a: 1 } } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      },
      'gemini-2.5-pro',
    );
    expect(r.finishReason).toBe('tool_calls');
    expect(r.message.content[1]).toMatchObject({ type: 'tool_call', name: 'f' });
    expect(r.usage).toEqual({ inputTokens: 2, outputTokens: 1 });
  });
});

describe('SSE', () => {
  it('parses frames and encodes them', async () => {
    const text = sseFrame({ a: 1 }, 'ping') + ': comment\n' + sseFrame('[DONE]');
    const body = new Blob([text]).stream() as ReadableStream<Uint8Array>;
    const frames: Array<{ event: string | undefined; data: string }> = [];
    for await (const f of parseSse(body)) frames.push(f);
    expect(frames).toEqual([
      { event: 'ping', data: '{"a":1}' },
      { event: undefined, data: '[DONE]' },
    ]);
  });
});
