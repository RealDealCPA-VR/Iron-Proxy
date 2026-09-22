import type {
  ContentPart,
  FinishReason,
  Message,
  ProviderId,
  StreamEvent,
  UnifiedRequest,
  Usage,
} from '../types.js';
import type { LaneResponse } from '../adapters/types.js';

/* ---------- OpenAI Chat Completions wire types (subset) ---------- */

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  [k: string]: unknown;
}

export type OpenAIMessage =
  | { role: 'system' | 'developer'; content: string; name?: string }
  | { role: 'user'; content: string | OpenAIContentPart[]; name?: string }
  | {
      role: 'assistant';
      content: string | null;
      name?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; content: string; tool_call_id: string };

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

export interface OpenAIChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAIChatChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: OpenAIChatResponse['usage'] | null;
}

/* ---------- unified -> OpenAI ---------- */

export function toOpenAIRequest(
  req: UnifiedRequest,
  model: string,
  stream: boolean,
): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) messages.push(...toOpenAIMessages(m));

  const out: OpenAIChatRequest = { model, messages };
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.parameters,
      },
    }));
  }
  if (req.toolChoice) {
    out.tool_choice =
      typeof req.toolChoice === 'string'
        ? req.toolChoice
        : { type: 'function', function: { name: req.toolChoice.name } };
  }
  if (req.maxTokens !== undefined) out.max_completion_tokens = req.maxTokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.stop?.length) out.stop = req.stop;
  if (stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (req.extra) Object.assign(out, req.extra);
  return out;
}

function toOpenAIMessages(m: Message): OpenAIMessage[] {
  if (m.role === 'system') {
    return [{ role: 'system', content: textOf(m.content), ...(m.name ? { name: m.name } : {}) }];
  }
  if (m.role === 'tool') {
    return m.content
      .filter((p): p is Extract<ContentPart, { type: 'tool_result' }> => p.type === 'tool_result')
      .map((p) => ({ role: 'tool', content: p.content, tool_call_id: p.toolCallId }));
  }
  if (m.role === 'assistant') {
    const text = textOf(m.content);
    const calls = m.content.filter(
      (p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call',
    );
    const msg: Extract<OpenAIMessage, { role: 'assistant' }> = {
      role: 'assistant',
      content: text || null,
    };
    if (m.name) msg.name = m.name;
    if (calls.length) {
      msg.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    }
    return [msg];
  }
  // user
  const parts: OpenAIContentPart[] = [];
  const toolResults: OpenAIMessage[] = [];
  for (const p of m.content) {
    if (p.type === 'text') parts.push({ type: 'text', text: p.text });
    else if (p.type === 'image')
      parts.push({ type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } });
    else if (p.type === 'image_url') parts.push({ type: 'image_url', image_url: { url: p.url } });
    else if (p.type === 'tool_result')
      toolResults.push({ role: 'tool', content: p.content, tool_call_id: p.toolCallId });
  }
  const out: OpenAIMessage[] = [...toolResults];
  if (parts.length) {
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({
      role: 'user',
      content: onlyText ? parts.map((p) => (p as { text: string }).text).join('') : parts,
      ...(m.name ? { name: m.name } : {}),
    });
  }
  return out;
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/* ---------- OpenAI -> unified ---------- */

export function mapOpenAIFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

export function mapOpenAIUsage(
  u: OpenAIChatResponse['usage'] | null | undefined,
): Usage | undefined {
  if (!u) return undefined;
  const out: Usage = {};
  if (u.prompt_tokens !== undefined) out.inputTokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.outputTokens = u.completion_tokens;
  if (u.prompt_tokens_details?.cached_tokens !== undefined)
    out.cacheReadTokens = u.prompt_tokens_details.cached_tokens;
  return out;
}

export function fromOpenAIResponse(res: OpenAIChatResponse): LaneResponse {
  const choice = res.choices[0];
  const content: ContentPart[] = [];
  if (choice?.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const tc of choice?.message.tool_calls ?? []) {
    content.push({
      type: 'tool_call',
      id: tc.id,
      name: tc.function.name,
      arguments: safeJson(tc.function.arguments),
    });
  }
  const out: LaneResponse = {
    id: res.id,
    model: res.model,
    message: { role: 'assistant', content },
    finishReason: mapOpenAIFinish(choice?.finish_reason),
    raw: res,
  };
  const usage = mapOpenAIUsage(res.usage);
  if (usage) out.usage = usage;
  return out;
}

export function safeJson(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { _raw: s };
  }
}

/** Stateful converter of OpenAI chunks into unified stream events. */
export class OpenAIChunkTranslator {
  private started = false;
  private readonly openCalls = new Map<number, string>();
  constructor(private readonly meta: { provider: ProviderId; profileId: string }) {}

  translate(chunk: OpenAIChatChunk): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({
        type: 'start',
        id: chunk.id,
        model: chunk.model,
        provider: this.meta.provider,
        profileId: this.meta.profileId,
      });
    }
    const choice = chunk.choices[0];
    if (choice) {
      if (choice.delta.content) out.push({ type: 'text', delta: choice.delta.content });
      for (const tc of choice.delta.tool_calls ?? []) {
        let id = this.openCalls.get(tc.index);
        if (!id) {
          id = tc.id ?? `call_${tc.index}`;
          this.openCalls.set(tc.index, id);
          out.push({ type: 'tool_call_start', id, name: tc.function?.name ?? '' });
        }
        if (tc.function?.arguments)
          out.push({ type: 'tool_call_delta', id, argumentsDelta: tc.function.arguments });
      }
      if (choice.finish_reason) {
        for (const id of this.openCalls.values()) out.push({ type: 'tool_call_end', id });
        this.openCalls.clear();
        out.push({ type: 'finish', finishReason: mapOpenAIFinish(choice.finish_reason) });
      }
    }
    const usage = mapOpenAIUsage(chunk.usage);
    if (usage) out.push({ type: 'usage', usage });
    return out;
  }
}

/* ---------- unified stream -> OpenAI chunks (for the proxy) ---------- */

export function toOpenAIChunk(
  ev: StreamEvent,
  id: string,
  model: string,
  created: number,
): OpenAIChatChunk | undefined {
  const base = { id, model, created, object: 'chat.completion.chunk' as const };
  switch (ev.type) {
    case 'start':
      return {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      };
    case 'text':
      return {
        ...base,
        choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null }],
      };
    case 'tool_call_start':
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: ev.id,
                  type: 'function',
                  function: { name: ev.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
    case 'tool_call_delta':
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: ev.argumentsDelta } }] },
            finish_reason: null,
          },
        ],
      };
    case 'finish':
      return {
        ...base,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason:
              ev.finishReason === 'tool_calls'
                ? 'tool_calls'
                : ev.finishReason === 'length'
                  ? 'length'
                  : 'stop',
          },
        ],
      };
    case 'usage':
      return {
        ...base,
        choices: [],
        usage: {
          prompt_tokens: ev.usage.inputTokens ?? 0,
          completion_tokens: ev.usage.outputTokens ?? 0,
        },
      };
    default:
      return undefined;
  }
}

export function toOpenAIResponse(res: {
  id: string;
  model: string;
  message: Message;
  finishReason: FinishReason;
  usage?: Usage;
}): OpenAIChatResponse & { object: 'chat.completion'; created: number } {
  const text = textOf(res.message.content);
  const calls = res.message.content.filter(
    (p): p is Extract<ContentPart, { type: 'tool_call' }> => p.type === 'tool_call',
  );
  return {
    id: res.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: res.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(calls.length
            ? {
                tool_calls: calls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                })),
              }
            : {}),
        },
        finish_reason:
          res.finishReason === 'tool_calls'
            ? 'tool_calls'
            : res.finishReason === 'length'
              ? 'length'
              : 'stop',
      },
    ],
    usage: {
      prompt_tokens: res.usage?.inputTokens ?? 0,
      completion_tokens: res.usage?.outputTokens ?? 0,
    },
  };
}

/* ---------- OpenAI request -> unified (for the proxy) ---------- */

export function fromOpenAIRequest(body: OpenAIChatRequest): UnifiedRequest {
  const messages: Message[] = [];
  let system: string | undefined;
  for (const m of body.messages) {
    if (m.role === 'system' || m.role === 'developer') {
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: m.tool_call_id, content: m.content }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const content: ContentPart[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls ?? []) {
        content.push({
          type: 'tool_call',
          id: tc.id,
          name: tc.function.name,
          arguments: safeJson(tc.function.arguments),
        });
      }
      messages.push({ role: 'assistant', content, ...(m.name ? { name: m.name } : {}) });
      continue;
    }
    const content: ContentPart[] = [];
    if (typeof m.content === 'string') content.push({ type: 'text', text: m.content });
    else {
      for (const p of m.content) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text });
        else if (p.type === 'image_url') {
          const dm = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url.url);
          if (dm) content.push({ type: 'image', mimeType: dm[1]!, data: dm[2]! });
          else content.push({ type: 'image_url', url: p.image_url.url });
        }
      }
    }
    messages.push({ role: 'user', content, ...(m.name ? { name: m.name } : {}) });
  }
  const out: UnifiedRequest = { messages };
  if (body.model) out.model = body.model;
  if (system) out.system = system;
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }
  if (body.tool_choice) {
    out.toolChoice =
      typeof body.tool_choice === 'string'
        ? body.tool_choice
        : { name: body.tool_choice.function.name };
  }
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) out.maxTokens = max;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.topP = body.top_p;
  if (body.stop?.length) out.stop = body.stop;
  return out;
}
