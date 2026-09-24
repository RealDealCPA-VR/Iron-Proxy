/**
 * HTTP implementation of the core `IronClient` contract, talking to the
 * proxy's `/iron/*` control API. Browser-safe: only `fetch` and
 * `ReadableStream`, no Node imports (types only from core).
 */
import type {
  AdoptLoginInput,
  CliProbe,
  DiscoveredLogin,
  IronClient,
  IronEvent,
  LoginCommandInfo,
  Profile,
  ProfileInput,
  ProfilePatch,
  ProfileState,
  ProviderId,
  ProviderInfo,
} from '@iron-proxy/core';

export interface HttpIronClientOptions {
  /** Initial reconnect delay for the event stream. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Give up waiting for a login after this long. */
  loginTimeoutMs?: number;
}

export class HttpIronClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** What the user should do next, from the proxy's `iron.hint`. */
    readonly hint: string | undefined = undefined,
  ) {
    super(message);
    this.name = 'HttpIronClientError';
  }
}

export class HttpIronClient implements IronClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: Required<HttpIronClientOptions>;

  constructor(
    baseUrl: string,
    private readonly token: string,
    fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a),
    opts: HttpIronClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.opts = {
      reconnectMinMs: opts.reconnectMinMs ?? 500,
      reconnectMaxMs: opts.reconnectMaxMs ?? 10_000,
      loginTimeoutMs: opts.loginTimeoutMs ?? 15 * 60_000,
    };
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, accept: 'application/json', ...extra };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const j = (json ?? {}) as {
        error?: { message?: string };
        iron?: { code?: string; details?: Record<string, unknown>; hint?: string };
      };
      throw new HttpIronClientError(
        res.status,
        j.iron?.code ?? `HTTP_${res.status}`,
        j.error?.message ?? `HTTP ${res.status} from ${path}`,
        j.iron?.details ?? {},
        typeof j.iron?.hint === 'string' && j.iron.hint ? j.iron.hint : undefined,
      );
    }
    return json as T;
  }

  providers(): Promise<ProviderInfo[]> {
    return this.call('GET', '/iron/providers');
  }
  listProfiles(): Promise<Profile[]> {
    return this.call('GET', '/iron/profiles');
  }
  states(): Promise<Record<string, ProfileState>> {
    return this.call('GET', '/iron/states');
  }
  createProfile(input: ProfileInput & { apiKeySecret?: string }): Promise<Profile> {
    return this.call('POST', '/iron/profiles', input);
  }
  updateProfile(id: string, patch: ProfilePatch): Promise<Profile> {
    return this.call('PATCH', `/iron/profiles/${encodeURIComponent(id)}`, patch);
  }
  async deleteProfile(id: string): Promise<void> {
    await this.call('DELETE', `/iron/profiles/${encodeURIComponent(id)}`);
  }
  reorder(provider: ProviderId, ids: string[]): Promise<Profile[]> {
    return this.call('POST', '/iron/profiles/reorder', { provider, ids });
  }
  activate(id: string): Promise<Profile> {
    return this.call('POST', `/iron/profiles/${encodeURIComponent(id)}/activate`);
  }
  async setApiKey(id: string, secret: string): Promise<void> {
    await this.call('POST', `/iron/profiles/${encodeURIComponent(id)}/api-key`, { secret });
  }

  /** Starts the login, then waits on the event stream for completed / failed / cancelled. */
  async login(id: string): Promise<void> {
    let settle!: { resolve(): void; reject(e: Error): void };
    const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    const off = this.onEvent((ev) => {
      if (ev.type !== 'login' || ev.event.profileId !== id) return;
      if (ev.event.type === 'completed') settle.resolve();
      else if (ev.event.type === 'failed')
        settle.reject(new HttpIronClientError(0, 'LOGIN_FAILED', ev.event.message));
      else if (ev.event.type === 'cancelled')
        settle.reject(new HttpIronClientError(0, 'LOGIN_CANCELLED', 'Login cancelled.'));
    });
    const timer = setTimeout(
      () => settle.reject(new HttpIronClientError(0, 'TIMEOUT', 'Login timed out.')),
      this.opts.loginTimeoutMs,
    );
    try {
      await this.call('POST', `/iron/profiles/${encodeURIComponent(id)}/login`);
      await done;
    } finally {
      clearTimeout(timer);
      off();
    }
  }
  async cancelLogin(id: string): Promise<void> {
    await this.call('POST', `/iron/profiles/${encodeURIComponent(id)}/login/cancel`);
  }
  loginCommand(id: string): Promise<LoginCommandInfo> {
    return this.call('GET', `/iron/profiles/${encodeURIComponent(id)}/login-command`);
  }
  async logout(id: string): Promise<void> {
    await this.call('POST', `/iron/profiles/${encodeURIComponent(id)}/logout`);
  }
  refreshStatus(id?: string): Promise<ProfileState[]> {
    return this.call('POST', '/iron/refresh', id ? { id } : {});
  }
  async unpark(id: string): Promise<void> {
    await this.call('POST', `/iron/profiles/${encodeURIComponent(id)}/unpark`);
  }
  listModels(id: string): Promise<string[]> {
    return this.call('GET', `/iron/profiles/${encodeURIComponent(id)}/models`);
  }
  doctor(): Promise<CliProbe[]> {
    return this.call('GET', '/iron/doctor');
  }
  discoverLogins(): Promise<DiscoveredLogin[]> {
    return this.call('GET', '/iron/discover');
  }
  adoptLogin(input: AdoptLoginInput): Promise<Profile> {
    return this.call('POST', '/iron/adopt', input);
  }

  /** Subscribe to `/iron/events`. Reconnects with backoff until unsubscribed. */
  onEvent(listener: (event: IronEvent) => void): () => void {
    const controller = new AbortController();
    let delay = this.opts.reconnectMinMs;
    const loop = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await this.fetchImpl(`${this.baseUrl}/iron/events`, {
            headers: this.headers({ accept: 'text/event-stream' }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`events stream HTTP ${res.status}`);
          delay = this.opts.reconnectMinMs;
          for await (const frame of parseSseStream(res.body, controller.signal)) {
            if (!frame.data) continue;
            try {
              listener(JSON.parse(frame.data) as IronEvent);
            } catch {
              /* ignore malformed frames */
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, this.opts.reconnectMaxMs);
      }
    };
    void loop();
    return () => controller.abort();
  }
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line === '') {
          if (data.length)
            yield { ...(event !== undefined ? { event } : {}), data: data.join('\n') };
          event = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Read `<dataDir>/proxy.json` written by `iron-proxy serve`, when running in Node. */
export interface ProxyDescriptor {
  url: string;
  token: string;
  pid: number;
}
