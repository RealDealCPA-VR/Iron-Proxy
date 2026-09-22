import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  IronProxyError,
  LocalIronClient,
  PROVIDER_IDS,
  anthropicWire,
  inferProvider,
  openaiWire,
  serializeError,
  sseFrame,
  type IronEvent,
  type IronProxy,
  type LoginSession,
  type ProviderId,
  type RunOptions,
  type SerializedError,
  type StreamEvent,
  type UnifiedRequest,
} from '@iron-proxy/core';

export interface ProxyServerOptions {
  iron: IronProxy;
  /** Bind address. Loopback by default; anything else exposes every account on the machine to the network. */
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** Bearer token for the control API. Generated when omitted. */
  token?: string;
  /**
   * Model routes (`/v1/*`) work without a token by default because the server
   * binds to loopback and most SDKs cannot add custom headers easily. Turn this
   * on when binding to a non-loopback host.
   */
  requireAuthForModels?: boolean;
  /** Add CORS headers. `true` allows any origin, a string allows that origin only. */
  cors?: boolean | string;
  /** Max request body in bytes. */
  maxBodyBytes?: number;
  /** Heartbeat interval for `/iron/events`. */
  heartbeatMs?: number;
}

export interface ProxyServer {
  server: Server;
  token: string;
  listen(): Promise<{ host: string; port: number; url: string; token: string }>;
  close(): Promise<void>;
}

type Dialect = 'openai' | 'anthropic' | 'json';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'INVALID_REQUEST',
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const STATUS_BY_CODE: Record<string, number> = {
  NO_PROFILE: 404,
  PROFILE_NOT_FOUND: 404,
  AUTH_REQUIRED: 401,
  ALL_PROFILES_EXHAUSTED: 429,
  QUOTA_EXCEEDED: 429,
  INVALID_REQUEST: 400,
  UNSUPPORTED: 400,
  TIMEOUT: 504,
  ABORTED: 499,
  STREAM_INTERRUPTED: 502,
};

export function statusForCode(code: string): number {
  return STATUS_BY_CODE[code] ?? 502;
}

function retryAfterSeconds(details: Record<string, unknown> | undefined): number | undefined {
  const at = details?.earliestResetAt;
  if (typeof at !== 'string') return undefined;
  const ms = new Date(at).getTime() - Date.now();
  if (Number.isNaN(ms)) return undefined;
  return Math.max(1, Math.ceil(ms / 1000));
}

export function errorBody(dialect: Dialect, err: SerializedError): Record<string, unknown> {
  const iron = { code: err.code, retryable: err.retryable, details: err.details ?? {} };
  if (dialect === 'openai') {
    return {
      error: {
        message: err.message,
        type: err.code.toLowerCase(),
        code: err.code.toLowerCase(),
        param: null,
      },
      iron,
    };
  }
  if (dialect === 'anthropic') {
    return { type: 'error', error: { type: err.code.toLowerCase(), message: err.message }, iron };
  }
  return { error: { message: err.message, code: err.code }, iron };
}

export function createProxyServer(opts: ProxyServerOptions): ProxyServer {
  const iron = opts.iron;
  const client = new LocalIronClient(iron);
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(24).toString('base64url');
  const tokenBuf = Buffer.from(token);
  const maxBody = opts.maxBodyBytes ?? 20 * 1024 * 1024;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const logins = new Map<string, LoginSession>();
  const sockets = new Set<ServerResponse>();

  function corsHeaders(req: IncomingMessage): Record<string, string> {
    if (!opts.cors) return {};
    const origin = opts.cors === true ? (req.headers.origin ?? '*') : opts.cors;
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers':
        'authorization, content-type, x-iron-token, x-iron-provider, x-iron-profile, anthropic-version, x-api-key',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-expose-headers': 'x-iron-profile, retry-after',
      ...(opts.cors === true ? { vary: 'origin' } : {}),
    };
  }

  function presentedToken(req: IncomingMessage): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const x = req.headers['x-iron-token'];
    if (typeof x === 'string') return x.trim();
    return undefined;
  }

  function tokenOk(presented: string | undefined): boolean {
    if (presented === undefined) return false;
    const b = Buffer.from(presented);
    return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
  }

  function authorize(req: IncomingMessage, required: boolean): void {
    const presented = presentedToken(req);
    if (presented === undefined) {
      if (required) throw new HttpError(401, 'Missing bearer token.', 'AUTH_REQUIRED');
      return;
    }
    // A token that looks like a provider key (SDK default headers) is ignored, not rejected.
    if (!tokenOk(presented)) {
      if (required) throw new HttpError(401, 'Invalid token.', 'AUTH_REQUIRED');
    }
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) {
          reject(new HttpError(413, `Request body exceeds ${maxBody} bytes.`, 'INVALID_REQUEST'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function readJson<T = Record<string, unknown>>(req: IncomingMessage): Promise<T> {
    const text = await readBody(req);
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(400, 'Body is not valid JSON.');
    }
  }

  function send(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      ...headers,
    });
    res.end(text);
  }

  function sendError(
    res: ServerResponse,
    req: IncomingMessage,
    dialect: Dialect,
    err: unknown,
  ): void {
    let status: number;
    let ser: SerializedError;
    if (err instanceof HttpError) {
      status = err.status;
      ser = {
        name: 'HttpError',
        message: err.message,
        code: err.code,
        retryable: false,
        details: err.extra,
      };
    } else if (err instanceof IronProxyError) {
      ser = err.toJSON();
      status = statusForCode(err.code);
    } else if (isSerialized(err)) {
      ser = err;
      status = statusForCode(err.code);
    } else {
      ser = serializeError(err);
      status = statusForCode(ser.code);
    }
    const headers: Record<string, string> = { ...corsHeaders(req) };
    if (status === 429) {
      const ra = retryAfterSeconds(ser.details);
      if (ra !== undefined) headers['retry-after'] = String(ra);
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    send(res, status, errorBody(dialect, ser), headers);
  }

  function runOptions(req: IncomingMessage, body: Record<string, unknown>): RunOptions {
    const out: RunOptions = {};
    const provider = req.headers['x-iron-provider'];
    if (typeof provider === 'string' && provider) {
      if (!PROVIDER_IDS.includes(provider as ProviderId)) {
        throw new HttpError(
          400,
          `Unknown provider "${provider}". Known: ${PROVIDER_IDS.join(', ')}.`,
        );
      }
      out.provider = provider as ProviderId;
    }
    const profile = req.headers['x-iron-profile'];
    if (typeof profile === 'string' && profile) out.profileId = profile;
    if (!out.provider && !out.profileId && typeof body.model === 'string') {
      const inferred = inferProvider(body.model);
      if (inferred) out.provider = inferred;
    }
    return out;
  }

  /** Pull the first event so an early failure can still become a proper HTTP status. */
  async function startStream(
    gen: AsyncGenerator<StreamEvent>,
  ): Promise<{ first: StreamEvent[]; gen: AsyncGenerator<StreamEvent> }> {
    const first: StreamEvent[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) return { first, gen };
      const ev = r.value;
      first.push(ev);
      if (ev.type === 'error' && first.length === 1) throw ev.error;
      if (ev.type === 'start' || ev.type === 'error') return { first, gen };
    }
  }

  const sseHeaders = (req: IncomingMessage): Record<string, string> => ({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...corsHeaders(req),
  });

  /* ------------------------------------------------------------ */
  /* Model routes                                                 */
  /* ------------------------------------------------------------ */

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authorize(req, opts.requireAuthForModels ?? false);
    const body = await readJson<openaiWire.OpenAIChatRequest>(req);
    if (!Array.isArray(body.messages)) throw new HttpError(400, '`messages` must be an array.');
    const unified: UnifiedRequest = openaiWire.fromOpenAIRequest(body);
    const ro = runOptions(req, body as unknown as Record<string, unknown>);
    const created = Math.floor(Date.now() / 1000);

    if (!body.stream) {
      const result = await iron.complete(unified, ro);
      send(res, 200, openaiWire.toOpenAIResponse(result), {
        'x-iron-profile': result.profileId,
        ...corsHeaders(req),
      });
      return;
    }

    const { first, gen } = await startStream(iron.stream(unified, ro));
    let id = `chatcmpl_${randomBytes(8).toString('hex')}`;
    let model = body.model ?? '';
    res.writeHead(200, sseHeaders(req));
    const write = (ev: StreamEvent): void => {
      if (ev.type === 'switched') {
        res.write(`: iron switched ${ev.fromProfileId} -> ${ev.toProfileId}\n\n`);
        return;
      }
      if (ev.type === 'start') {
        id = ev.id || id;
        model = ev.model || model;
        res.write(`: iron profile ${ev.profileId}\n\n`);
      }
      if (ev.type === 'error') {
        res.write(sseFrame(errorBody('openai', ev.error)));
        return;
      }
      const chunk = openaiWire.toOpenAIChunk(ev, id, model, created);
      if (chunk) res.write(sseFrame(chunk));
    };
    try {
      for (const ev of first) write(ev);
      for await (const ev of gen) write(ev);
    } finally {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authorize(req, opts.requireAuthForModels ?? false);
    const body = await readJson<anthropicWire.AnthropicRequest>(req);
    if (!Array.isArray(body.messages)) throw new HttpError(400, '`messages` must be an array.');
    if (typeof body.model !== 'string' || !body.model)
      throw new HttpError(400, '`model` is required.');
    if (typeof body.max_tokens !== 'number') throw new HttpError(400, '`max_tokens` is required.');
    const unified = anthropicWire.fromAnthropicRequest(body);
    const ro = runOptions(req, body as unknown as Record<string, unknown>);

    if (!body.stream) {
      const result = await iron.complete(unified, ro);
      send(res, 200, anthropicWire.toAnthropicResponse(result), {
        'x-iron-profile': result.profileId,
        ...corsHeaders(req),
      });
      return;
    }

    const { first, gen } = await startStream(iron.stream(unified, ro));
    const tr = new anthropicWire.ToAnthropicStream();
    let id = `msg_${randomBytes(8).toString('hex')}`;
    let model = body.model;
    res.writeHead(200, sseHeaders(req));
    const write = (ev: StreamEvent): void => {
      if (ev.type === 'switched') {
        res.write(`: iron switched ${ev.fromProfileId} -> ${ev.toProfileId}\n\n`);
        return;
      }
      if (ev.type === 'start') {
        id = ev.id || id;
        model = ev.model || model;
        res.write(`: iron profile ${ev.profileId}\n\n`);
      }
      for (const a of tr.translate(ev, id, model)) res.write(sseFrame(a, a.type));
    };
    try {
      for (const ev of first) write(ev);
      for await (const ev of gen) write(ev);
    } finally {
      res.end();
    }
  }

  async function models(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authorize(req, opts.requireAuthForModels ?? false);
    const created = Math.floor(Date.now() / 1000);
    const seen = new Map<string, ProviderId>();
    for (const p of await iron.listProfiles()) {
      if (p.enabled && p.defaultModel) seen.set(p.defaultModel, p.provider);
    }
    for (const a of iron.registry.list()) if (a.defaultModel) seen.set(a.defaultModel, a.id);
    const data = [...seen.entries()].map(([id, owned_by]) => ({
      id,
      object: 'model',
      created,
      owned_by,
    }));
    send(res, 200, { object: 'list', data }, corsHeaders(req));
  }

  /* ------------------------------------------------------------ */
  /* Control routes                                               */
  /* ------------------------------------------------------------ */

  function events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, sseHeaders(req));
    res.write(': connected\n\n');
    sockets.add(res);
    const off = iron.events.onAny((ev: IronEvent) => {
      res.write(sseFrame(ev, ev.type));
    });
    const hb = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    hb.unref?.();
    const cleanup = () => {
      clearInterval(hb);
      off();
      sockets.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async function control(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/iron/health') {
      send(
        res,
        200,
        { ok: true, name: 'iron-proxy', profiles: (await iron.listProfiles()).length },
        corsHeaders(req),
      );
      return;
    }
    authorize(req, true);
    const method = req.method ?? 'GET';
    const h = corsHeaders(req);
    const parts = path.split('/').filter(Boolean); // ['iron', 'profiles', id?, action?]
    const sub = parts[1];
    const id = parts[2];
    const action = parts[3];
    const action2 = parts[4];

    if (sub === 'events' && method === 'GET') return events(req, res);
    if (sub === 'providers' && method === 'GET') return send(res, 200, await client.providers(), h);
    if (sub === 'states' && method === 'GET') return send(res, 200, await client.states(), h);
    if (sub === 'doctor' && method === 'GET') return send(res, 200, await client.doctor(), h);
    if (sub === 'refresh' && method === 'POST') {
      const body = await readJson<{ id?: string }>(req);
      return send(res, 200, await client.refreshStatus(body.id), h);
    }
    if (sub === 'profiles') {
      if (!id && method === 'GET') return send(res, 200, await client.listProfiles(), h);
      if (!id && method === 'POST') {
        const body = await readJson<Parameters<typeof client.createProfile>[0]>(req);
        return send(res, 201, await client.createProfile(body), h);
      }
      if (id === 'reorder' && method === 'POST') {
        const body = await readJson<{ provider: ProviderId; ids: string[] }>(req);
        if (!body.provider || !Array.isArray(body.ids))
          throw new HttpError(400, '`provider` and `ids` are required.');
        return send(res, 200, await client.reorder(body.provider, body.ids), h);
      }
      if (!id) throw new HttpError(405, 'Method not allowed.');
      if (!action) {
        if (method === 'GET') return send(res, 200, await iron.getProfile(id), h);
        if (method === 'PATCH')
          return send(res, 200, await client.updateProfile(id, await readJson(req)), h);
        if (method === 'DELETE') {
          await client.deleteProfile(id);
          return send(res, 200, { ok: true }, h);
        }
        throw new HttpError(405, 'Method not allowed.');
      }
      if (method === 'POST' && action === 'activate')
        return send(res, 200, await client.activate(id), h);
      if (method === 'POST' && action === 'api-key') {
        const body = await readJson<{ secret?: string }>(req);
        if (typeof body.secret !== 'string' || !body.secret)
          throw new HttpError(400, '`secret` is required.');
        await client.setApiKey(id, body.secret);
        return send(res, 200, { ok: true }, h);
      }
      if (method === 'POST' && action === 'login' && !action2) {
        const session = await iron.login(id);
        logins.set(id, session);
        session.done
          .catch(() => {})
          .finally(() => {
            if (logins.get(id) === session) logins.delete(id);
          });
        return send(res, 202, { profileId: id, started: true }, h);
      }
      if (method === 'POST' && action === 'login' && action2 === 'cancel') {
        logins.get(id)?.cancel();
        await client.cancelLogin(id);
        return send(res, 200, { ok: true }, h);
      }
      if (method === 'GET' && action === 'login-command')
        return send(res, 200, await client.loginCommand(id), h);
      if (method === 'POST' && action === 'logout') {
        await client.logout(id);
        return send(res, 200, { ok: true }, h);
      }
      if (method === 'POST' && action === 'unpark') {
        await client.unpark(id);
        return send(res, 200, { ok: true }, h);
      }
      if (method === 'GET' && action === 'models')
        return send(res, 200, await client.listModels(id), h);
    }
    throw new HttpError(404, `No control route ${method} ${path}.`, 'INVALID_REQUEST');
  }

  /* ------------------------------------------------------------ */
  /* Dispatch                                                     */
  /* ------------------------------------------------------------ */

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const dialect: Dialect = path.startsWith('/v1/messages')
      ? 'anthropic'
      : path.startsWith('/v1/')
        ? 'openai'
        : 'json';
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS' && opts.cors) {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    (async () => {
      if (path === '/v1/chat/completions' && method === 'POST') return chatCompletions(req, res);
      if (path === '/v1/messages' && method === 'POST') return messages(req, res);
      if (path === '/v1/models' && method === 'GET') return models(req, res);
      if (path.startsWith('/iron/')) return control(req, res, path);
      if (path === '/' && method === 'GET') {
        return send(
          res,
          200,
          {
            name: 'iron-proxy',
            endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/models', '/iron/*'],
          },
          corsHeaders(req),
        );
      }
      throw new HttpError(404, `No route ${method} ${path}.`);
    })().catch((err) => sendError(res, req, dialect, err));
  });
  server.keepAliveTimeout = 65_000;

  return {
    server,
    token,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port ?? 0, host, () => {
          server.off('error', reject);
          const addr = server.address() as AddressInfo;
          const shownHost = addr.address.includes(':') ? `[${addr.address}]` : addr.address;
          resolve({
            host: addr.address,
            port: addr.port,
            url: `http://${shownHost}:${addr.port}`,
            token,
          });
        });
      });
    },
    close() {
      for (const s of sockets) s.end();
      sockets.clear();
      for (const l of logins.values()) l.cancel();
      logins.clear();
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) =>
          err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ? reject(err)
            : resolve(),
        );
      });
    },
  };
}

function isSerialized(err: unknown): err is SerializedError {
  return (
    !!err &&
    typeof err === 'object' &&
    typeof (err as SerializedError).code === 'string' &&
    typeof (err as SerializedError).message === 'string' &&
    'retryable' in (err as object)
  );
}
