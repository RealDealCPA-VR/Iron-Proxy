import type {
  ContentPart,
  FinishReason,
  ProviderId,
  StreamEvent,
  UnifiedRequest,
  Usage,
} from '../types.js';
import type { LaneResponse } from '../adapters/types.js';

/* ---------- Gemini generateContent wire types (subset) ---------- */

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType?: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: {
    functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] };
  };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  [k: string]: unknown;
}

export interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[]; role?: string }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
}

/* ---------- unified -> Gemini ---------- */

export function toGeminiRequest(req: UnifiedRequest): GeminiRequest {
  const contents: GeminiContent[] = [];
  let system = req.system;
  // Map tool call ids to names so tool results can be attributed (Gemini keys by name).
  const callNames = new Map<string, string>();
  for (const m of req.messages) {
    if (m.role === 'system') {
      const t = textOf(m.content);
      system = system ? `${system}\n\n${t}` : t;
      continue;
    }
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];
    for (const p of m.content) {
      switch (p.type) {
        case 'text':
          if (p.text) parts.push({ text: p.text });
          break;
        case 'image':
          parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } });
          break;
        case 'image_url':
          parts.push({ fileData: { fileUri: p.url } });
          break;
        case 'tool_call':
          callNames.set(p.id, p.name);
          parts.push({ functionCall: { name: p.name, args: p.arguments } });
          break;
        case 'tool_result': {
          const name = callNames.get(p.toolCallId) ?? p.toolCallId;
          let response: Record<string, unknown>;
          try {
            const v = JSON.parse(p.content);
            response =
              typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { result: v };
          } catch {
            response = { result: p.content };
          }
          if (p.isError) response = { error: response };
          parts.push({ functionResponse: { name, response } });
          break;
        }
      }
    }
    if (!parts.length) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const out: GeminiRequest = { contents };
  if (system) out.systemInstruction = { parts: [{ text: system }] };
  if (req.tools?.length) {
    out.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: stripSchema(t.parameters),
        })),
      },
    ];
  }
  if (req.toolChoice) {
    out.toolConfig = {
      functionCallingConfig:
        req.toolChoice === 'auto'
          ? { mode: 'AUTO' }
          : req.toolChoice === 'none'
            ? { mode: 'NONE' }
            : req.toolChoice === 'required'
              ? { mode: 'ANY' }
              : { mode: 'ANY', allowedFunctionNames: [req.toolChoice.name] },
    };
  }
  const gc: NonNullable<GeminiRequest['generationConfig']> = {};
  if (req.maxTokens !== undefined) gc.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) gc.temperature = req.temperature;
  if (req.topP !== undefined) gc.topP = req.topP;
  if (req.stop?.length) gc.stopSequences = req.stop;
  if (Object.keys(gc).length) out.generationConfig = gc;
  if (req.extra) Object.assign(out, req.extra);
  return out;
}

/** Gemini rejects some JSON Schema keywords; drop the usual offenders. */
function stripSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const drop = new Set(['$schema', 'additionalProperties', '$id', 'examples', 'default']);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (drop.has(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(schema) as Record<string, unknown>;
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/* ---------- Gemini -> unified ---------- */

export function mapGeminiFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter';
    default:
      return 'other';
  }
}

export function mapGeminiUsage(u: GeminiResponse['usageMetadata']): Usage | undefined {
  if (!u) return undefined;
  const out: Usage = {};
  if (u.promptTokenCount !== undefined) out.inputTokens = u.promptTokenCount;
  if (u.candidatesTokenCount !== undefined) out.outputTokens = u.candidatesTokenCount;
  if (u.cachedContentTokenCount !== undefined) out.cacheReadTokens = u.cachedContentTokenCount;
  return out;
}

let callCounter = 0;
function nextCallId(): string {
  callCounter = (callCounter + 1) % 1_000_000;
  return `gcall_${Date.now().toString(36)}_${callCounter}`;
}

export function fromGeminiResponse(res: GeminiResponse, model: string): LaneResponse {
  const cand = res.candidates?.[0];
  const content: ContentPart[] = [];
  let hasCall = false;
  for (const p of cand?.content?.parts ?? []) {
    if ('text' in p && p.text) content.push({ type: 'text', text: p.text });
    else if ('functionCall' in p) {
      hasCall = true;
      content.push({
        type: 'tool_call',
        id: nextCallId(),
        name: p.functionCall.name,
        arguments: p.functionCall.args ?? {},
      });
    }
  }
  const out: LaneResponse = {
    id: res.responseId ?? `gemini_${Date.now().toString(36)}`,
    model: res.modelVersion ?? model,
    message: { role: 'assistant', content },
    finishReason: hasCall ? 'tool_calls' : mapGeminiFinish(cand?.finishReason),
    raw: res,
  };
  const usage = mapGeminiUsage(res.usageMetadata);
  if (usage) out.usage = usage;
  return out;
}

export class GeminiChunkTranslator {
  private started = false;
  private sawCall = false;
  constructor(private readonly meta: { provider: ProviderId; profileId: string; model: string }) {}

  translate(chunk: GeminiResponse): StreamEvent[] {
    const out: StreamEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({
        type: 'start',
        id: chunk.responseId ?? `gemini_${Date.now().toString(36)}`,
        model: chunk.modelVersion ?? this.meta.model,
        provider: this.meta.provider,
        profileId: this.meta.profileId,
      });
    }
    const cand = chunk.candidates?.[0];
    for (const p of cand?.content?.parts ?? []) {
      if ('text' in p && p.text) out.push({ type: 'text', delta: p.text });
      else if ('functionCall' in p) {
        this.sawCall = true;
        const id = nextCallId();
        out.push({ type: 'tool_call_start', id, name: p.functionCall.name });
        out.push({
          type: 'tool_call_delta',
          id,
          argumentsDelta: JSON.stringify(p.functionCall.args ?? {}),
        });
        out.push({ type: 'tool_call_end', id });
      }
    }
    const usage = mapGeminiUsage(chunk.usageMetadata);
    if (usage) out.push({ type: 'usage', usage });
    if (cand?.finishReason)
      out.push({
        type: 'finish',
        finishReason: this.sawCall ? 'tool_calls' : mapGeminiFinish(cand.finishReason),
      });
    return out;
  }
}
