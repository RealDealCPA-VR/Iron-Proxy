import type { Profile, StreamEvent, UnifiedRequest } from '../../types.js';
import { parseSse } from '../../translate/sse.js';
import {
  fromGeminiResponse,
  GeminiChunkTranslator,
  toGeminiRequest,
  type GeminiResponse,
} from '../../translate/google.js';
import type { AttemptContext, Lane, LaneResponse } from '../types.js';
import type { Vault } from '../../vault/vault.js';
import { joinUrl, postJson, requireKey } from './shared.js';

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const GOOGLE_DEFAULT_MODEL = 'gemini-2.5-pro';

export class GoogleApiLane implements Lane {
  readonly kind = 'api-key' as const;

  private base(profile: Profile): string {
    return profile.apiKey?.baseUrl ?? GOOGLE_BASE_URL;
  }

  private headers(profile: Profile, key: string): Record<string, string> {
    return { 'x-goog-api-key': key, ...(profile.apiKey?.headers ?? {}) };
  }

  private modelPath(model: string): string {
    return model.startsWith('models/') ? model : `models/${model}`;
  }

  async complete(req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse> {
    const key = await requireKey(ctx);
    const model = req.model ?? ctx.profile.defaultModel ?? GOOGLE_DEFAULT_MODEL;
    const res = await postJson(
      'google',
      {
        url: joinUrl(this.base(ctx.profile), `${this.modelPath(model)}:generateContent`),
        headers: this.headers(ctx.profile, key),
        body: toGeminiRequest(req),
      },
      ctx,
    );
    return fromGeminiResponse((await res.json()) as GeminiResponse, model);
  }

  async *stream(req: UnifiedRequest, ctx: AttemptContext): AsyncIterable<StreamEvent> {
    const key = await requireKey(ctx);
    const model = req.model ?? ctx.profile.defaultModel ?? GOOGLE_DEFAULT_MODEL;
    const res = await postJson(
      'google',
      {
        url: joinUrl(
          this.base(ctx.profile),
          `${this.modelPath(model)}:streamGenerateContent?alt=sse`,
        ),
        headers: this.headers(ctx.profile, key),
        body: toGeminiRequest(req),
      },
      ctx,
    );
    const tr = new GeminiChunkTranslator({ provider: 'google', profileId: ctx.profile.id, model });
    let finished = false;
    for await (const frame of parseSse(res.body, ctx.signal)) {
      let chunk: GeminiResponse;
      try {
        chunk = JSON.parse(frame.data) as GeminiResponse;
      } catch {
        continue;
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
    const res = await ctx.fetch(joinUrl(this.base(profile), '/models?pageSize=200'), {
      headers: this.headers(profile, key),
      signal: ctx.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).map((m) => m.name.replace(/^models\//, '')).sort();
  }
}
