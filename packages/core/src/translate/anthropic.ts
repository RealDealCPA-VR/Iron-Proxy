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
import { safeJson } from './openai.js';

/* ---------- Anthropic Messages wire types (subset) ---------- */

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | Array<{ type: 'text'; text: string }>;
      is_error?: boolean;
    };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | Array<{ type: 'text'; text: string }>;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto' | 'any' | 'none' } | { type: 'tool'; name: string };
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  [k: string]: unknown;
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicResponse }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string | null };
      usage?: { output_tokens?: number };
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/* ---------- unified -> Anthropic ---------- */

export function toAnthropicRequest(
  req: UnifiedRequest,
  model: string,
  stream: boolean,
): AnthropicRequest {
  const messages: AnthropicMessage[] = [];
  let system = req.system;
  for (const m of req.messages) {
    if (m.role === 'system') {
      const t = textOf(m.content);
      system = system ? `${system}\n\n${t}` : t;
      continue;
    }
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocks = toAnthropicBlocks(m.content);
    if (!blocks.length) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  const out: AnthropicRequest = {
    model,
    max_tokens: req.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system) out.system = system;
  if (req.tools?.length) {
    out.tools = req.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: t.parameters,
    }));
  }
  if (req.toolChoice) {
    out.tool_choice =
      req.toolChoice === 'auto'
        ? { type: 'auto' }
        : req.toolChoice === 'none'
          ? { type: 'none' }
          : req.toolChoice === 'required'
            ? { type: 'any' }
            : { type: 'tool', name: req.toolChoice.name };
  }
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.topP !== undefined) out.top_p = req.topP;
  if (req.stop?.length) out.stop_sequences = req.stop;
  if (stream) out.stream = true;
  if (req.extra) Object.assign(out, req.extra);
  return out;
}

function toAnthropicBlocks(parts: ContentPart[]): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = [];
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        if (p.text) out.push({ type: 'text', text: p.text });
        break;
      case 'image':
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: p.mimeType, data: p.data },
        });
        break;
      case 'image_url':
        out.push({ type: 'image', source: { type: 'url', url: p.url } });
        break;
      case 'tool_call':
        out.push({ type: 'tool_use', id: p.id, name: p.name, input: p.arguments });
        break;
      case 'tool_result':
        out.push({
          type: 'tool_result',
          tool_use_id: p.toolCallId,
          content: p.content,
          ...(p.isError ? { is_error: true } : {}),
        });
        break;
    }
  }
  return out;
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/* ---------- Anthropic -> unified ---------- */

export function mapAnthropicStop(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}

export function mapAnthropicUsage(u: AnthropicResponse['usage'] | undefined): Usage | undefined {
  if (!u) return undefined;
  const out: Usage = {};
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (u.cache_read_input_tokens !== undefined) out.cacheReadTokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens !== undefined)
    out.cacheWriteTokens = u.cache_creation_input_tokens;
  return out;
}

export function fromAnthropicResponse(res: AnthropicResponse): LaneResponse {
  const content: ContentPart[] = [];
  for (const b of res.content) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use')
      content.push({ type: 'tool_call', id: b.id, name: b.name, arguments: b.input });
  }
  const out: LaneResponse = {
    id: res.id,
    model: res.model,
    message: { role: 'assistant', content },
    finishReason: mapAnthropicStop(res.stop_reason),
    raw: res,
  };
  const usage = mapAnthropicUsage(res.usage);
  if (usage) out.usage = usage;
  return out;
}

export class AnthropicEventTranslator {
  private readonly blocks = new Map<number, { id: string; name: string }>();
  private usage: Usage = {};
  constructor(private readonly meta: { provider: ProviderId; profileId: string }) {}

  translate(ev: AnthropicStreamEvent): StreamEvent[] {
    switch (ev.type) {
      case 'message_start': {
        const u = mapAnthropicUsage(ev.message.usage);
        if (u) this.usage = { ...this.usage, ...u };
        return [
          {
            type: 'start',
            id: ev.message.id,
            model: ev.message.model,
            provider: this.meta.provider,
            profileId: this.meta.profileId,
          },
        ];
      }
      case 'content_block_start':
        if (ev.content_block.type === 'tool_use') {
          this.blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name });
          return [
            { type: 'tool_call_start', id: ev.content_block.id, name: ev.content_block.name },
          ];
        }
        if (ev.content_block.type === 'text' && ev.content_block.text)
          return [{ type: 'text', delta: ev.content_block.text }];
        return [];
      case 'content_block_delta':
        if (ev.delta.type === 'text_delta') return [{ type: 'text', delta: ev.delta.text }];
        if (ev.delta.type === 'input_json_delta') {
          const b = this.blocks.get(ev.index);
          return b
            ? [{ type: 'tool_call_delta', id: b.id, argumentsDelta: ev.delta.partial_json }]
            : [];
        }
        return [];
      case 'content_block_stop': {
        const b = this.blocks.get(ev.index);
        if (b) {
          this.blocks.delete(ev.index);
          return [{ type: 'tool_call_end', id: b.id }];
        }
        return [];
      }
      case 'message_delta': {
        const out: StreamEvent[] = [];
        if (ev.usage?.output_tokens !== undefined) this.usage.outputTokens = ev.usage.output_tokens;
        out.push({ type: 'usage', usage: { ...this.usage } });
        out.push({ type: 'finish', finishReason: mapAnthropicStop(ev.delta.stop_reason) });
        return out;
      }
      case 'error':
        return [
          {
            type: 'error',
            error: {
              name: ev.error.type,
              message: ev.error.message,
              code: 'PROVIDER_ERROR',
              retryable: false,
            },
          },
        ];
      default:
        return [];
    }
  }
}

/* ---------- Anthropic request -> unified (for the proxy) ---------- */

export function fromAnthropicRequest(body: AnthropicRequest): UnifiedRequest {
  const messages: Message[] = [];
  for (const m of body.messages) {
    const content: ContentPart[] = [];
    if (typeof m.content === 'string') content.push({ type: 'text', text: m.content });
    else {
      for (const b of m.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          if (b.source.type === 'base64')
            content.push({ type: 'image', mimeType: b.source.media_type, data: b.source.data });
          else content.push({ type: 'image_url', url: b.source.url });
        } else if (b.type === 'tool_use')
          content.push({ type: 'tool_call', id: b.id, name: b.name, arguments: b.input });
        else if (b.type === 'tool_result') {
          const text =
            typeof b.content === 'string' ? b.content : b.content.map((c) => c.text).join('');
          content.push({
            type: 'tool_result',
            toolCallId: b.tool_use_id,
            content: text,
            ...(b.is_error ? { isError: true } : {}),
          });
        }
      }
    }
    messages.push({ role: m.role, content });
  }
  const out: UnifiedRequest = { messages, model: body.model, maxTokens: body.max_tokens };
  if (body.system)
    out.system =
      typeof body.system === 'string' ? body.system : body.system.map((s) => s.text).join('\n\n');
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema,
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    out.toolChoice =
      tc.type === 'tool' ? { name: tc.name } : tc.type === 'any' ? 'required' : tc.type;
  }
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.topP = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  return out;
}

/* ---------- unified -> Anthropic response / stream (for the proxy) ---------- */

export function toAnthropicResponse(res: {
  id: string;
  model: string;
  message: Message;
  finishReason: FinishReason;
  usage?: Usage;
}): AnthropicResponse {
  const content: AnthropicContentBlock[] = [];
  for (const p of res.message.content) {
    if (p.type === 'text') content.push({ type: 'text', text: p.text });
    else if (p.type === 'tool_call')
      content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.arguments });
  }
  return {
    id: res.id,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content,
    stop_reason:
      res.finishReason === 'tool_calls'
        ? 'tool_use'
        : res.finishReason === 'length'
          ? 'max_tokens'
          : 'end_turn',
    usage: {
      input_tokens: res.usage?.inputTokens ?? 0,
      output_tokens: res.usage?.outputTokens ?? 0,
    },
  };
}

/** Converts unified events into Anthropic SSE events, tracking block indices. */
export class ToAnthropicStream {
  private index = -1;
  private textOpen = false;
  private readonly toolIndex = new Map<string, number>();
  private usage: Usage = {};

  translate(ev: StreamEvent, id: string, model: string): AnthropicStreamEvent[] {
    switch (ev.type) {
      case 'start':
        return [
          {
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        ];
      case 'text': {
        const out: AnthropicStreamEvent[] = [];
        if (!this.textOpen) {
          this.index++;
          this.textOpen = true;
          out.push({
            type: 'content_block_start',
            index: this.index,
            content_block: { type: 'text', text: '' },
          });
        }
        out.push({
          type: 'content_block_delta',
          index: this.index,
          delta: { type: 'text_delta', text: ev.delta },
        });
        return out;
      }
      case 'tool_call_start': {
        const out: AnthropicStreamEvent[] = [];
        if (this.textOpen) {
          out.push({ type: 'content_block_stop', index: this.index });
          this.textOpen = false;
        }
        this.index++;
        this.toolIndex.set(ev.id, this.index);
        out.push({
          type: 'content_block_start',
          index: this.index,
          content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} },
        });
        return out;
      }
      case 'tool_call_delta': {
        const i = this.toolIndex.get(ev.id);
        return i === undefined
          ? []
          : [
              {
                type: 'content_block_delta',
                index: i,
                delta: { type: 'input_json_delta', partial_json: ev.argumentsDelta },
              },
            ];
      }
      case 'tool_call_end': {
        const i = this.toolIndex.get(ev.id);
        return i === undefined ? [] : [{ type: 'content_block_stop', index: i }];
      }
      case 'usage':
        this.usage = { ...this.usage, ...ev.usage };
        return [];
      case 'finish': {
        const out: AnthropicStreamEvent[] = [];
        if (this.textOpen) {
          out.push({ type: 'content_block_stop', index: this.index });
          this.textOpen = false;
        }
        out.push({
          type: 'message_delta',
          delta: {
            stop_reason:
              ev.finishReason === 'tool_calls'
                ? 'tool_use'
                : ev.finishReason === 'length'
                  ? 'max_tokens'
                  : 'end_turn',
          },
          usage: { output_tokens: this.usage.outputTokens ?? 0 },
        });
        out.push({ type: 'message_stop' });
        return out;
      }
      case 'error':
        return [
          {
            type: 'error',
            error: { type: ev.error.code.toLowerCase(), message: ev.error.message },
          },
        ];
      default:
        return [];
    }
  }
}

export { safeJson };
