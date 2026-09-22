import type { Profile, ProviderId, StreamEvent, UnifiedRequest } from '../../types.js';
import { ProviderError } from '../../errors.js';
import { parseSse } from '../../translate/sse.js';
import {
  fromOpenAIResponse,
  OpenAIChunkTranslator,
  toOpenAIRequest,
  type OpenAIChatChunk,
  type OpenAIChatResponse,
} from '../../translate/openai.js';
import type { AttemptContext, Lane, LaneResponse } from '../types.js';
import type { Vault } from '../../vault/vault.js';
import { joinUrl, postJson, requireKey } from './shared.js';

export interface OpenAIChatLaneOptions {
  provider: ProviderId;
  defaultBaseUrl: string;
  defaultModel: string;
  /** Header used for the key. OpenAI, xAI and most gateways use bearer auth. */
  authHeader?: (key: string) => Record<string, string>;
}

/**
 * API-key lane for any Chat Completions compatible endpoint: OpenAI, xAI,
 * OpenRouter, Groq, Together, Ollama, LM Studio, vLLM, LiteLLM, and so on.
 */
export class OpenAIChatLane implements Lane {
  readonly kind = 'api-key' as const;
  constructor(private readonly opts: OpenAIChatLaneOptions) {}

  private base(profile: Profile): string {
    return profile.apiKey?.baseUrl ?? this.opts.defaultBaseUrl;
  }

  private headers(profile: Profile, key: string): Record<string, string> {
    const auth = this.opts.authHeader
      ? this.opts.authHeader(key)
      : { authorization: `Bearer ${key}` };
    return { ...auth, ...(profile.apiKey?.headers ?? {}) };
  }

  async complete(req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse> {
    const key = await requireKey(ctx);
    const model = req.model ?? ctx.profile.defaultModel ?? this.opts.defaultModel;
    const res = await postJson(
      this.opts.provider,
      {
        url: joinUrl(this.base(ctx.profile), '/chat/completions'),
        headers: this.headers(ctx.profile, key),
        body: toOpenAIRequest(req, model, false),
      },
      ctx,
    );
    const json = (await res.json()) as OpenAIChatResponse;
    if (!json.choices)
      throw new ProviderError(`${this.opts.provider} returned no choices.`, {
        details: { body: json },
      });
    return fromOpenAIResponse(json);
  }

  async *stream(req: UnifiedRequest, ctx: AttemptContext): AsyncIterable<StreamEvent> {
    const key = await requireKey(ctx);
    const model = req.model ?? ctx.profile.defaultModel ?? this.opts.defaultModel;
    const res = await postJson(
      this.opts.provider,
      {
        url: joinUrl(this.base(ctx.profile), '/chat/completions'),
        headers: this.headers(ctx.profile, key),
        body: toOpenAIRequest(req, model, true),
      },
      ctx,
    );
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/event-stream')) {
      // Some gateways ignore stream=true. Fall back to a single response.
      const json = (await res.json()) as OpenAIChatResponse;
      const full = fromOpenAIResponse(json);
      yield {
        type: 'start',
        id: full.id,
        model: full.model,
        provider: this.opts.provider,
        profileId: ctx.profile.id,
      };
      for (const p of full.message.content) {
        if (p.type === 'text') yield { type: 'text', delta: p.text };
        if (p.type === 'tool_call') {
          yield { type: 'tool_call_start', id: p.id, name: p.name };
          yield { type: 'tool_call_delta', id: p.id, argumentsDelta: JSON.stringify(p.arguments) };
          yield { type: 'tool_call_end', id: p.id };
        }
      }
      if (full.usage) yield { type: 'usage', usage: full.usage };
      yield { type: 'finish', finishReason: full.finishReason };
      return;
    }
    const tr = new OpenAIChunkTranslator({
      provider: this.opts.provider,
      profileId: ctx.profile.id,
    });
    let finished = false;
    for await (const frame of parseSse(res.body, ctx.signal)) {
      if (frame.data === '[DONE]') break;
      let chunk: OpenAIChatChunk;
      try {
        chunk = JSON.parse(frame.data) as OpenAIChatChunk;
      } catch {
        continue;
      }
      if ((chunk as unknown as { error?: { message?: string } }).error) {
        const e = (chunk as unknown as { error: { message?: string } }).error;
        throw new ProviderError(e.message ?? 'stream error', { details: { chunk } });
      }
      for (const ev of tr.translate(chunk)) {
        if (ev.type === 'finish') finished = true;
        yield ev;
      }
    }
    if (!finished) yield { type: 'finish', finishReason: 'stop' };
  }

  async checkAuth(profile: Profile, vault: Vault): Promise<'ok' | 'unauthenticated' | 'unknown'> {
    if (!profile.apiKey?.secretRef) return 'unauthenticated';
    return (await vault.has(profile.apiKey.secretRef)) ? 'unknown' : 'unauthenticated';
  }

  async logout(profile: Profile, vault: Vault): Promise<void> {
    if (profile.apiKey?.secretRef) await vault.delete(profile.apiKey.secretRef);
  }

  async listModels(profile: Profile, ctx: AttemptContext): Promise<string[]> {
    const key = await requireKey(ctx);
    const res = await ctx.fetch(joinUrl(this.base(profile), '/models'), {
      headers: this.headers(profile, key),
      signal: ctx.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id).sort();
  }
}
