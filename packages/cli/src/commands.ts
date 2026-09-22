import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createIronProxy,
  defaultDataDir,
  IronProxyError,
  PROVIDER_IDS,
  type IronProxy,
  type LaneKind,
  type Profile,
  type ProfileState,
  type ProviderId,
  type UnifiedRequest,
} from '@iron-proxy/core';
import { createProxyServer } from '@iron-proxy/proxy';

export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  /** Inject a manager (tests). Otherwise one is created from --data-dir. */
  iron?: IronProxy;
  /** Read stdin fully (for --api-key-stdin and chat prompts from a pipe). */
  readStdin?: () => Promise<string>;
  /** Called by `serve` to wait for shutdown; default waits for SIGINT/SIGTERM. */
  waitForShutdown?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

const HELP = `iron-proxy — bring-your-own-subscription account switching for AI providers

Usage:
  iron-proxy serve [--port 8791] [--host 127.0.0.1] [--token T] [--data-dir D] [--cors]
  iron-proxy profiles list [--json]
  iron-proxy profiles add --provider P --lane cli|api-key --title T [--model M] [--api-key-stdin] [--base-url URL]
  iron-proxy profiles rename <id> <title>
  iron-proxy profiles remove <id>
  iron-proxy profiles reorder <provider> <id> [<id> ...]
  iron-proxy profiles activate|enable|disable <id>
  iron-proxy login <id> [--terminal]
  iron-proxy logout <id>
  iron-proxy status [--json]
  iron-proxy doctor [--json]
  iron-proxy models <id>
  iron-proxy chat <provider-or-model> [-m model] [--profile id] "prompt"

Providers: ${PROVIDER_IDS.join(', ')}
Data dir:  --data-dir or IRON_PROXY_DATA_DIR (default ~/.iron-proxy)
`;

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        json: { type: 'boolean' },
        port: { type: 'string' },
        host: { type: 'string' },
        token: { type: 'string' },
        'data-dir': { type: 'string' },
        cors: { type: 'boolean' },
        terminal: { type: 'boolean' },
        provider: { type: 'string' },
        lane: { type: 'string' },
        title: { type: 'string' },
        model: { type: 'string', short: 'm' },
        'api-key-stdin': { type: 'boolean' },
        'base-url': { type: 'string' },
        profile: { type: 'string' },
      },
    });
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  if (!cmd || values.help) {
    io.stdout.write(HELP);
    return values.help ? 0 : 1;
  }

  const dataDir =
    (values['data-dir'] as string | undefined) ??
    (io.env ?? process.env).IRON_PROXY_DATA_DIR ??
    defaultDataDir();
  const iron = io.iron ?? createIronProxy({ dataDir });
  const own = !io.iron;
  const json = !!values.json;
  const out = (s: string) => io.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  const err = (s: string) => io.stderr.write(s.endsWith('\n') ? s : `${s}\n`);

  try {
    switch (cmd) {
      case 'serve':
        return await serve(
          iron,
          io,
          dataDir,
          values as Record<string, string | boolean | undefined>,
        );
      case 'profiles':
        return await profiles(
          iron,
          io,
          rest,
          values as Record<string, string | boolean | undefined>,
          json,
        );
      case 'login': {
        const id = need(rest[0], 'profile id');
        if (values.terminal) {
          const cmdInfo = await iron.loginCommand(id);
          const envLine = Object.entries(cmdInfo.env)
            .filter(([k]) => /^(CLAUDE_CONFIG_DIR|CODEX_HOME|GROK_HOME|GEMINI_CLI_HOME)$/.test(k))
            .map(([k, v]) => (process.platform === 'win32' ? `$env:${k}="${v}";` : `${k}="${v}"`))
            .join(' ');
          out(
            `Run this in a terminal window:\n\n  ${envLine} ${quote(cmdInfo.binary)} ${cmdInfo.args.map(quote).join(' ')}\n`,
          );
          if (cmdInfo.requiresTerminal)
            out('This CLI has no headless login; it signs in interactively on first run.');
          return 0;
        }
        const session = await iron.login(id);
        session.on((e) => {
          if (e.type === 'url') out(`Open this URL to sign in: ${e.url}`);
          else if (e.type === 'code') out(`Enter this code: ${e.code}`);
          else if (e.type === 'output') err(`  ${e.line}`);
          else if (e.type === 'completed') out('Logged in.');
          else if (e.type === 'failed') err(`Login failed: ${e.message}`);
        });
        await session.done;
        return 0;
      }
      case 'logout':
        await iron.logout(need(rest[0], 'profile id'));
        out('Logged out.');
        return 0;
      case 'status':
        return await status(iron, io, json);
      case 'doctor': {
        const probes = await iron.doctor();
        if (json) out(JSON.stringify(probes, null, 2));
        else {
          out(
            table(
              ['provider', 'binary', 'found', 'version', 'home env', 'path'],
              probes.map((p) => [
                p.provider,
                p.binary,
                p.found ? 'yes' : 'no',
                p.version ?? '',
                p.homeEnv,
                p.path ?? '',
              ]),
            ),
          );
        }
        return 0;
      }
      case 'models': {
        const models = await iron.listModels(need(rest[0], 'profile id'));
        out(json ? JSON.stringify(models) : models.join('\n') || '(none reported)');
        return 0;
      }
      case 'chat':
        return await chat(iron, io, rest, values as Record<string, string | boolean | undefined>);
      default:
        err(`Unknown command "${cmd}".\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof IronProxyError) err(`${e.code}: ${e.message}`);
    else err((e as Error).message ?? String(e));
    return 1;
  } finally {
    if (own && cmd !== 'serve') await iron.close();
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new IronProxyError('INVALID_REQUEST', `Missing ${what}.`);
  return v;
}

function quote(s: string): string {
  return /[\s"']/.test(s) || s === '' ? JSON.stringify(s) : s;
}

async function serve(
  iron: IronProxy,
  io: CliIo,
  dataDir: string,
  v: Record<string, string | boolean | undefined>,
): Promise<number> {
  const port = v.port !== undefined ? Number(v.port) : 8791;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new IronProxyError('INVALID_REQUEST', `Bad port "${v.port}".`);
  const host = (v.host as string | undefined) ?? '127.0.0.1';
  const proxy = createProxyServer({
    iron,
    host,
    port,
    ...(typeof v.token === 'string' ? { token: v.token } : {}),
    ...(v.cors ? { cors: true } : {}),
    requireAuthForModels: host !== '127.0.0.1' && host !== 'localhost' && host !== '::1',
  });
  const info = await proxy.listen();
  const descriptor = join(dataDir, 'proxy.json');
  await writeFile(
    descriptor,
    JSON.stringify({ url: info.url, token: info.token, pid: process.pid }, null, 2),
    { mode: 0o600 },
  );
  io.stdout.write(
    `Iron-Proxy listening on ${info.url}\n  OpenAI-compatible:    ${info.url}/v1/chat/completions\n  Anthropic-compatible: ${info.url}/v1/messages\n  Control API token:    ${info.token}\n  Descriptor:           ${descriptor}\n`,
  );
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    io.stderr.write(
      'Warning: bound to a non-loopback host; every account here is reachable from the network. Model routes now require the token.\n',
    );
  }
  const wait =
    io.waitForShutdown ??
    (() =>
      new Promise<void>((resolve) => {
        const stop = () => resolve();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      }));
  await wait();
  await proxy.close();
  await rm(descriptor, { force: true }).catch(() => {});
  await iron.close();
  return 0;
}

async function profiles(
  iron: IronProxy,
  io: CliIo,
  rest: string[],
  v: Record<string, string | boolean | undefined>,
  json: boolean,
): Promise<number> {
  const out = (s: string) => io.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  const [sub, ...args] = rest;
  switch (sub ?? 'list') {
    case 'list': {
      const list = await iron.listProfiles();
      out(
        json
          ? JSON.stringify(list, null, 2)
          : table(
              ['id', 'title', 'provider', 'lane', 'order', 'enabled', 'model'],
              list.map((p) => [
                p.id,
                p.title,
                p.provider,
                p.lane,
                String(p.order),
                p.enabled ? 'yes' : 'no',
                p.defaultModel ?? '',
              ]),
            ),
      );
      return 0;
    }
    case 'add': {
      const provider = v.provider as string | undefined;
      const lane = (v.lane as string | undefined) ?? 'cli';
      const title = v.title as string | undefined;
      if (!provider || !PROVIDER_IDS.includes(provider as ProviderId))
        throw new IronProxyError(
          'INVALID_REQUEST',
          `--provider must be one of ${PROVIDER_IDS.join(', ')}.`,
        );
      if (!['cli', 'api-key', 'oauth'].includes(lane))
        throw new IronProxyError('INVALID_REQUEST', '--lane must be cli, api-key or oauth.');
      if (!title) throw new IronProxyError('INVALID_REQUEST', '--title is required.');
      let apiKeySecret: string | undefined;
      if (v['api-key-stdin']) {
        const read = io.readStdin ?? defaultReadStdin;
        apiKeySecret = (await read()).trim();
        if (!apiKeySecret) throw new IronProxyError('INVALID_REQUEST', 'No API key on stdin.');
      }
      const created = await iron.createProfile({
        title,
        provider: provider as ProviderId,
        lane: lane as LaneKind,
        ...(typeof v.model === 'string' ? { defaultModel: v.model } : {}),
        ...(lane === 'api-key' && typeof v['base-url'] === 'string'
          ? { apiKey: { secretRef: '', baseUrl: v['base-url'] } }
          : {}),
        ...(apiKeySecret ? { apiKeySecret } : {}),
      });
      if (created.apiKey && created.apiKey.secretRef === '') {
        // createProfile replaced the empty ref; nothing to do. Kept for clarity.
      }
      out(
        json
          ? JSON.stringify(created, null, 2)
          : `Created ${created.id} (${created.title}, ${created.provider}/${created.lane}).${created.lane === 'cli' ? ` Next: iron-proxy login ${created.id}` : created.lane === 'api-key' && !apiKeySecret ? ' Next: set its key with --api-key-stdin on add, or via the API.' : ''}`,
      );
      return 0;
    }
    case 'rename': {
      const p = await iron.updateProfile(need(args[0], 'profile id'), {
        title: need(args[1], 'new title'),
      });
      out(`Renamed ${p.id} to "${p.title}".`);
      return 0;
    }
    case 'remove': {
      await iron.deleteProfile(need(args[0], 'profile id'));
      out('Removed.');
      return 0;
    }
    case 'reorder': {
      const provider = need(args[0], 'provider') as ProviderId;
      if (!PROVIDER_IDS.includes(provider))
        throw new IronProxyError('INVALID_REQUEST', `Unknown provider "${provider}".`);
      const ordered = await iron.reorder(provider, args.slice(1));
      out(ordered.map((p, i) => `${i}. ${p.title} (${p.id})`).join('\n'));
      return 0;
    }
    case 'activate': {
      const p = await iron.activate(need(args[0], 'profile id'));
      out(`"${p.title}" is now first for ${p.provider}.`);
      return 0;
    }
    case 'enable':
    case 'disable': {
      const p = await iron.updateProfile(need(args[0], 'profile id'), {
        enabled: sub === 'enable',
      });
      out(`"${p.title}" ${p.enabled ? 'enabled' : 'disabled'}.`);
      return 0;
    }
    default:
      throw new IronProxyError('INVALID_REQUEST', `Unknown profiles subcommand "${sub}".`);
  }
}

async function status(iron: IronProxy, io: CliIo, json: boolean): Promise<number> {
  const list = await iron.listProfiles();
  const states = await iron.allStates();
  if (json) {
    io.stdout.write(
      JSON.stringify(
        list.map((p) => ({ profile: p, state: states[p.id] })),
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  const rows = list.map((p) => {
    const s: ProfileState | undefined = states[p.id];
    const active = iron.activeProfileId(p.provider) === p.id ? '*' : '';
    return [
      active,
      p.id,
      p.title,
      p.provider,
      p.lane,
      String(p.order),
      s?.status ?? 'unknown',
      s?.parkedUntil ? fmtTime(s.parkedUntil) : '',
      s?.usage?.utilisation !== undefined ? `${Math.round(s.usage.utilisation * 100)}%` : '',
      s?.lastUsedAt ? fmtTime(s.lastUsedAt) : '',
    ];
  });
  io.stdout.write(
    table(
      [
        '',
        'id',
        'title',
        'provider',
        'lane',
        'order',
        'status',
        'parked until',
        'used',
        'last used',
      ],
      rows,
    ) + '\n',
  );
  return 0;
}

async function chat(
  iron: IronProxy,
  io: CliIo,
  rest: string[],
  v: Record<string, string | boolean | undefined>,
): Promise<number> {
  const [target, ...promptParts] = rest;
  if (!target)
    throw new IronProxyError('INVALID_REQUEST', 'Usage: chat <provider-or-model> "prompt"');
  let prompt = promptParts.join(' ');
  if (!prompt) {
    const read = io.readStdin ?? defaultReadStdin;
    prompt = (await read()).trim();
  }
  if (!prompt) throw new IronProxyError('INVALID_REQUEST', 'No prompt given.');
  const opts: { provider?: ProviderId; profileId?: string } = {};
  const req: UnifiedRequest = {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  if (PROVIDER_IDS.includes(target as ProviderId)) opts.provider = target as ProviderId;
  else req.model = target;
  if (typeof v.model === 'string') req.model = v.model;
  if (typeof v.profile === 'string') opts.profileId = v.profile;

  let served: string | undefined;
  let failed = false;
  for await (const ev of iron.stream(req, opts)) {
    if (ev.type === 'start') served = ev.profileId;
    else if (ev.type === 'text') io.stdout.write(ev.delta);
    else if (ev.type === 'switched')
      io.stderr.write(
        `[iron] switched ${ev.fromProfileId} -> ${ev.toProfileId} (${ev.reason.kind})\n`,
      );
    else if (ev.type === 'error') {
      failed = true;
      io.stderr.write(`\n[iron] ${ev.error.code}: ${ev.error.message}\n`);
    }
  }
  io.stdout.write('\n');
  if (served) {
    const p: Profile | undefined = await iron.getProfile(served).catch(() => undefined);
    io.stderr.write(`[iron] served by ${p ? `"${p.title}"` : served} (${served})\n`);
  }
  return failed ? 1 : 0;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

async function defaultReadStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

/** Read the descriptor `iron-proxy serve` writes, if a proxy is running for this data dir. */
export async function readProxyDescriptor(
  dataDir = defaultDataDir(),
): Promise<{ url: string; token: string; pid: number } | undefined> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'proxy.json'), 'utf8')) as {
      url: string;
      token: string;
      pid: number;
    };
  } catch {
    return undefined;
  }
}
