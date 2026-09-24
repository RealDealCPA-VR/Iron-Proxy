import type { Profile, StreamEvent, UnifiedRequest } from '../../types.js';
import { ProviderError } from '../../errors.js';
import { parseSse } from '../../translate/sse.js';
import {
  AnthropicEventTranslator,
  fromAnthropicResponse,
  toAnthropicRequest,
  type AnthropicResponse,
  type AnthropicStreamEvent,
} from '../../translate/anthropic.js';
import { LaneQuotaSignal, type AttemptContext, type Lane, type LaneResponse } from '../types.js';
import { redactSecrets } from '../../util.js';
import type { Vault } from '../../vault/vault.js';
import { joinUrl, postJson, requireKey } from './shared.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';

export class AnthropicApiLane implements Lane {
  readonly kind = 'api-key' as const;

  private headers(profile: Profile, key: string): Record<string, string> {
    // Long-lived tokens from `claude setup-token` and OAuth extensions are bearer tokens.
    const auth = key.startsWith('sk-ant-oat')
      ? { authorization: `Bearer ${key}` }
      : { 'x-api-key': key };
    return { ...auth, 'anthropic-version': ANTHROPIC_VERSION, ...(profile.apiKey?.headers ?? {}) };
  }

  private base(profile: Profile): string {
    return profile.apiKey?.baseUrl ?? ANTHROPIC_BASE_URL;
  }

  async complete(req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse> {
    const key = await requireKey(ctx);
    const model = req.model ?? ctx.profile.defaultModel ?? ANTHROPIC_DEFAULT_MODEL;
    const res = await postJson(
      'anthropic',
      {
        url: joinUrl(this.base(ctx.profile), '/messages'),
        headers: this.headers(ctx.profile, key),
        body: toAnthropicRequest(req, model, false),
      },
      ctx,
    );
    const json = (await res.json()) as AnthropicResponse;
    if (json.type !== 'message')
      throw new ProviderError('Anthropic returned an unexpected body.', {
        details: { body: json },
      });
    return fromAnthropicResponse(json);
  }

  async *stream(req: UnifiedRequest, ctx: AttemptContext): AsyncIterable<StreamEvent> {
    const key = await requireKey(ctx);
    const model = req.model ?? ctx.profile.defaultModel ?? ANTHROPIC_DEFAULT_MODEL;
    const res = await postJson(
      'anthropic',
      {
        url: joinUrl(this.base(ctx.profile), '/messages'),
        headers: this.headers(ctx.profile, key),
        body: toAnthropicRequest(req, model, true),
      },
      ctx,
    );
    const tr = new AnthropicEventTranslator({ provider: 'anthropic', profileId: ctx.profile.id });
    let finished = false;
    for await (const frame of parseSse(res.body, ctx.signal)) {
      let ev: AnthropicStreamEvent;
      try {
        ev = JSON.parse(frame.data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      for (const out of tr.translate(ev)) {
        if (out.type === 'finish') finished = true;
        if (out.type === 'error') {
          // A limit announced mid-stream is the account's problem, not the request's.
          const kind =
            out.error.name === 'rate_limit_error'
              ? 'rate-limit'
              : out.error.name === 'overloaded_error'
                ? 'overloaded'
                : undefined;
          if (kind)
            throw new LaneQuotaSignal({
              kind,
              source: 'body',
              message: redactSecrets(out.error.message).slice(0, 240),
            });
          throw new ProviderError(out.error.message, { details: { event: ev } });
        }
        yield out;
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
    const res = await ctx.fetch(joinUrl(this.base(profile), '/models?limit=100'), {
      headers: this.headers(profile, key),
      signal: ctx.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id).sort();
  }
}
