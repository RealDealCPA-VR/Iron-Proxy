import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import {
  CliError,
  CliLane,
  CLI_SPECS,
  createIronProxy,
  defaultDataDir,
  installHint,
  IronProxyError,
  PROVIDER_IDS,
  PROVIDER_SHORT_NAMES,
  which,
  type IronProxy,
  type LaneKind,
  type Profile,
  type ProfileState,
  type ProviderId,
  type RunOptions,
  type UnifiedRequest,
  type UsageReport,
  type UsageWindowTotals,
} from '@iron-proxy/core';
import { createProxyServer } from '@iron-proxy/proxy';
import { buildLaunch, launchInteractive, type SpawnFn } from './launch.js';

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
  /** Starts the vendor CLI for `run` (tests pass one that pipes stdio). Default `child_process.spawn`. */
  spawn?: SpawnFn;
  /**
   * Asks one question and resolves with the answer line (for `setup`). With
   * `secret`, the answer must not be echoed. Default: node:readline on stdin/stdout.
   */
  prompt?: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  /** Platform used for defaults such as the `env` shell. Default `process.platform`. */
  platform?: NodeJS.Platform;
}

const HELP = `iron-proxy — bring-your-own-subscription account switching for AI providers

Usage:
  iron-proxy setup [--yes]
  iron-proxy serve [--port 8791] [--host 127.0.0.1] [--token T] [--data-dir D] [--cors]
  iron-proxy profiles list [--json]
  iron-proxy profiles add --provider P --lane cli|api-key --title T [--model M] [--api-key-stdin] [--base-url URL]
  iron-proxy profiles discover [--json]
  iron-proxy profiles adopt <provider> [--home DIR] [--title T]
  iron-proxy profiles rename <id> <title>
  iron-proxy profiles remove <id>
  iron-proxy profiles reorder <provider> <id> [<id> ...]
  iron-proxy profiles activate|enable|disable <id>
  iron-proxy login <id> [--terminal]
  iron-proxy logout <id>
  iron-proxy status [--json]
  iron-proxy usage [--json] [--profile id]
  iron-proxy doctor [--json]
  iron-proxy models <id>
  iron-proxy chat <provider-or-model> [-m model] [--profile id] [--resume] "prompt"
  iron-proxy run <provider> [--profile id] [-- extra args for the vendor CLI]
  iron-proxy env <provider> [--profile id] [--shell bash|powershell|cmd]

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
        home: { type: 'string' },
        shell: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        resume: { type: 'boolean' },
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
          await printTerminalLogin(iron, id, out);
          return 0;
        }
        await headlessLogin(iron, id, out, err);
        return 0;
      }
      case 'logout': {
        const id = need(rest[0], 'profile id');
        const p = await iron.getProfile(id);
        await iron.logout(id);
        out('Logged out.');
        if (p.cli?.adopted)
          err(
            `Note: "${p.title}" was an existing login, so your own ${p.provider} CLI is signed out too.`,
          );
        return 0;
      }
      case 'status':
        return await status(iron, io, json);
      case 'usage':
        return await usage(iron, io, json, values.profile as string | undefined);
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
      case 'run':
        return await runVendor(iron, io, rest, values.profile as string | undefined);
      case 'env':
        return await envLines(
          iron,
          io,
          rest,
          values.profile as string | undefined,
          values.shell as string | undefined,
        );
      case 'setup':
        return await setup(iron, io, !!values.yes);
      default:
        err(`Unknown command "${cmd}".\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof IronProxyError) err(`${e.code}: ${e.message}`);
    else err((e as Error).message ?? String(e));
    const hint = (e as { hint?: unknown } | undefined)?.hint;
    if (typeof hint === 'string' && hint) err(`hint: ${hint}`);
    return 1;
  } finally {
    if (own && cmd !== 'serve') await iron.close();
  }
}

async function printTerminalLogin(
  iron: IronProxy,
  id: string,
  out: (s: string) => void,
): Promise<void> {
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
}

/** Run the vendor CLI's own headless login, printing the URL and code it shows. */
async function headlessLogin(
  iron: IronProxy,
  id: string,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<void> {
  const session = await iron.login(id);
  session.on((e) => {
    if (e.type === 'url') out(`Open this URL to sign in: ${e.url}`);
    else if (e.type === 'code') out(`Enter this code: ${e.code}`);
    else if (e.type === 'output') err(`  ${e.line}`);
    else if (e.type === 'completed') out('Logged in.');
    else if (e.type === 'failed') err(`Login failed: ${e.message}`);
  });
  await session.done;
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
    case 'discover': {
      const found = await iron.discoverLogins();
      if (json) out(JSON.stringify(found, null, 2));
      else if (!found.length)
        out('No existing vendor CLI logins found in their default locations on this computer.');
      else
        out(
          table(
            ['provider', 'home', 'installed', 'signed in', 'already adopted'],
            found.map((f) => [
              f.provider,
              f.home,
              f.installed ? 'yes' : 'no',
              f.status === 'ok' ? 'yes' : f.status === 'unauthenticated' ? 'no' : '?',
              f.adoptedProfileId ?? 'no',
            ]),
          ),
        );
      return 0;
    }
    case 'adopt': {
      const provider = need(args[0], 'provider') as ProviderId;
      if (!PROVIDER_IDS.includes(provider))
        throw new IronProxyError('INVALID_REQUEST', `Unknown provider "${provider}".`, {
          hint: `Use one of: ${PROVIDER_IDS.join(', ')}.`,
        });
      let home = typeof v.home === 'string' ? v.home : undefined;
      if (!home) {
        // Only this provider's default home: no other vendor CLI is run.
        const found = iron.defaultCliHome(provider);
        if (!found || !(await isDir(found)))
          throw new IronProxyError(
            'INVALID_REQUEST',
            `No existing ${provider} CLI login found in its default location${found ? ` (${found})` : ''}.`,
            {
              hint: 'Run iron-proxy profiles discover to see what was found, or pass the directory with --home DIR.',
            },
          );
        home = found;
      }
      const p = await iron.adoptLogin({
        provider,
        home,
        ...(typeof v.title === 'string' ? { title: v.title } : {}),
      });
      // Check this one profile's sign-in (its own CLI's status command, nothing else).
      const checked = await iron.refreshStatus(p.id).catch(() => []);
      const st =
        checked.find((x) => x.profileId === p.id)?.status ??
        (await iron.allStates())[p.id]?.status ??
        'unknown';
      out(
        json
          ? JSON.stringify(p, null, 2)
          : `Adopted ${p.cli?.home} as ${p.id} ("${p.title}", ${st}). Iron-Proxy will never delete that directory.`,
      );
      if (st === 'unauthenticated')
        io.stderr.write(`Note: "${p.title}" is not signed in yet: iron-proxy login ${p.id}\n`);
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
  const opts: RunOptions = {};
  const req: UnifiedRequest = {
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  if (PROVIDER_IDS.includes(target as ProviderId)) opts.provider = target as ProviderId;
  else req.model = target;
  if (typeof v.model === 'string') req.model = v.model;
  if (typeof v.profile === 'string') opts.profileId = v.profile;
  // --resume: a limit hit mid-answer continues on the next account instead of stopping.
  if (v.resume) opts.resumeInterrupted = true;

  let served: string | undefined;
  let failed = false;
  for await (const ev of iron.stream(req, opts)) {
    if (ev.type === 'start') served = ev.profileId;
    else if (ev.type === 'text') io.stdout.write(ev.delta);
    else if (ev.type === 'switched') {
      // A resumed answer finishes on the new account (its own `start` is not repeated).
      if (ev.resumed) served = ev.toProfileId;
      io.stderr.write(
        `[iron] switched ${ev.fromProfileId} -> ${ev.toProfileId} (${ev.reason.kind}${ev.resumed ? ', resumed' : ''})\n`,
      );
    } else if (ev.type === 'error') {
      failed = true;
      io.stderr.write(`\n[iron] ${ev.error.code}: ${ev.error.message}\n`);
      if (ev.error.hint) io.stderr.write(`hint: ${ev.error.hint}\n`);
    }
  }
  io.stdout.write('\n');
  if (served) {
    const p: Profile | undefined = await iron.getProfile(served).catch(() => undefined);
    io.stderr.write(`[iron] served by ${p ? `"${p.title}"` : served} (${served})\n`);
  }
  return failed ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* run / env: the user's own terminal as one of their accounts          */
/* ------------------------------------------------------------------ */

function needProvider(v: string | undefined, usage: string): ProviderId {
  if (!v) throw new IronProxyError('INVALID_REQUEST', `Usage: ${usage}`);
  if (!PROVIDER_IDS.includes(v as ProviderId))
    throw new IronProxyError('INVALID_REQUEST', `Unknown provider "${v}".`, {
      hint: `Use one of: ${PROVIDER_IDS.join(', ')}.`,
    });
  return v as ProviderId;
}

/**
 * `run <provider>`: start the vendor CLI interactively as the account the router
 * would use first right now. The session stays on that account; the next `run`
 * picks again.
 */
async function runVendor(
  iron: IronProxy,
  io: CliIo,
  rest: string[],
  profileId: string | undefined,
): Promise<number> {
  const [target, ...extra] = rest;
  const provider = needProvider(target, 'run <provider> [--profile id] [-- extra args]');
  const p = await iron.pickProfile(provider, {
    lane: 'cli',
    ...(profileId ? { profileId } : {}),
  });
  const cmd = await iron.interactiveCommand(p.id, extra);
  const resolved = await which(cmd.binary);
  if (!resolved)
    throw new CliError('CLI_NOT_FOUND', `"${cmd.binary}" is not installed or not on PATH.`, {
      binary: cmd.binary,
    });
  io.stderr.write(`Using "${p.title}" (${p.provider})\n`);
  if (profileId) await notePinnedState(iron, io, p);
  return launchInteractive(io.spawn ?? nodeSpawn, buildLaunch(resolved, cmd.args), cmd.env);
}

/**
 * A pinned account is used even when it is parked or signed out (the user chose
 * it), but say so on stderr: the vendor CLI may refuse. Never prints an email.
 */
async function notePinnedState(iron: IronProxy, io: CliIo, p: Profile): Promise<void> {
  const st = (await iron.allStates())[p.id];
  if (st?.status === 'parked')
    io.stderr.write(
      st.parkedUntil
        ? `Note: "${p.title}" is parked until ${fmtTime(st.parkedUntil)}; it may refuse requests.\n`
        : `Note: "${p.title}" is parked; it may refuse requests.\n`,
    );
  else if (st?.status === 'unauthenticated')
    io.stderr.write(`Note: "${p.title}" is not signed in: iron-proxy login ${p.id}\n`);
}

type ShellKind = 'bash' | 'powershell' | 'cmd';

/** Single-quoted for POSIX shells: ' becomes '\''. */
function shQuote(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Single-quoted for PowerShell: ' becomes ''. */
function psQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * `env <provider>`: the lines that make the user's own shell act as that
 * account. Only the home variable (and the profile's own cli.env entries) are
 * set; API-key variables are cleared for bash and PowerShell. Never PATH, never
 * a secret.
 */
async function envLines(
  iron: IronProxy,
  io: CliIo,
  rest: string[],
  profileId: string | undefined,
  shellOpt: string | undefined,
): Promise<number> {
  const provider = needProvider(
    rest[0],
    'env <provider> [--profile id] [--shell bash|powershell|cmd]',
  );
  const shell = (shellOpt ??
    ((io.platform ?? process.platform) === 'win32' ? 'powershell' : 'bash')) as ShellKind;
  if (!['bash', 'powershell', 'cmd'].includes(shell))
    throw new IronProxyError('INVALID_REQUEST', `Unknown shell "${shellOpt}".`, {
      hint: 'Use --shell bash (also zsh), --shell powershell or --shell cmd.',
    });
  const p = await iron.pickProfile(provider, {
    lane: 'cli',
    ...(profileId ? { profileId } : {}),
  });
  const { set, unset } = await iron.shellEnv(p.id);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(set)) {
    if (shell === 'bash') lines.push(`export ${k}=${shQuote(v)}`);
    else if (shell === 'powershell') lines.push(`$env:${k} = ${psQuote(v)}`);
    else lines.push(`set "${k}=${v}"`);
  }
  if (shell === 'bash' && unset.length) lines.push(`unset ${unset.join(' ')}`);
  if (shell === 'powershell')
    for (const k of unset) lines.push(`Remove-Item Env:${k} -ErrorAction SilentlyContinue`);
  io.stdout.write(`${lines.join('\n')}\n`);
  io.stderr.write(`Using "${p.title}" (${p.provider})\n`);
  if (profileId) await notePinnedState(iron, io, p);
  io.stderr.write(
    shell === 'cmd'
      ? `Note: these lines set the account's home only; API-key variables are unset only by iron-proxy run ${provider}, so clear them yourself if they are set.\n`
      : `Note: these lines set the account's home and clear API-key variables in this shell; only iron-proxy run ${provider} starts the CLI with a fully scrubbed environment.\n`,
  );
  return 0;
}

/* ------------------------------------------------------------------ */
/* setup: guided first run                                              */
/* ------------------------------------------------------------------ */

type Ask = (question: string, opts?: { secret?: boolean }) => Promise<string>;

/**
 * A prompt on the terminal via node:readline. A secret answer is not echoed.
 *
 * Answers come from one line queue rather than `rl.question` per prompt, so
 * lines piped in all at once (several answers in one `printf | iron-proxy setup`)
 * are kept in order instead of being dropped between questions. After the input ends,
 * every further question resolves to ''. `input`/`output` are injectable for tests.
 */
export function readlinePrompt(
  streams: {
    input?: NodeJS.ReadableStream & { isTTY?: boolean };
    output?: { write(s: string | Buffer): unknown };
  } = {},
): { ask: Ask; close(): void } {
  const input = streams.input ?? process.stdin;
  const sink = streams.output ?? process.stdout;
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      if (!muted) sink.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input, output, terminal: !!input.isTTY });
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next('');
  });
  const nextLine = (): Promise<string> => {
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (closed) return Promise.resolve('');
    return new Promise((resolve) => waiting.push(resolve));
  };
  const ask: Ask = async (question, opts = {}) => {
    if (!opts.secret) {
      // readline draws the question as its own prompt, so a terminal redraw
      // (backspace, a resize) repaints the question instead of readline's default '> '.
      rl.setPrompt(question);
      rl.prompt(true);
      return nextLine();
    }
    // A secret: show the question once, then give readline an empty prompt while the
    // echo is muted, so a redraw has nothing to repaint.
    sink.write(question);
    rl.setPrompt('');
    muted = true;
    try {
      return await nextLine();
    } finally {
      muted = false;
      sink.write('\n');
    }
  };
  return { ask, close: () => rl.close() };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isYes(answer: string, byDefault: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (!a) return byDefault;
  return a === 'y' || a === 'yes';
}

function freeTitle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Ask until the answer is one of `choices` (by number or name); gives up after three tries. */
async function choose<T extends string>(
  ask: Ask,
  out: (s: string) => void,
  question: string,
  choices: Array<{ value: T; label: string }>,
): Promise<T> {
  out(choices.map((c, i) => `  ${i + 1}) ${c.label}`).join('\n'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const a = (await ask(`${question} [1-${choices.length}]: `)).trim();
    const byNumber = choices[Number(a) - 1];
    const picked = /^\d+$/.test(a) ? byNumber : choices.find((c) => c.value === a);
    if (picked) return picked.value;
    out(`Please answer with a number from 1 to ${choices.length}.`);
  }
  throw new IronProxyError('INVALID_REQUEST', 'No valid choice given.', {
    hint: 'Run iron-proxy setup again, or add the account with iron-proxy profiles add.',
  });
}

/** `setup`: doctor, adopt existing logins, add accounts, show the result. */
async function setup(iron: IronProxy, io: CliIo, yes: boolean): Promise<number> {
  const out = (s: string) => io.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  const errLine = (s: string) => io.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
  const own = !io.prompt && !yes ? readlinePrompt() : undefined;
  const ask: Ask = io.prompt ?? own?.ask ?? (async () => '');
  const report = (e: unknown) => {
    errLine(
      e instanceof IronProxyError ? `${e.code}: ${e.message}` : String((e as Error).message ?? e),
    );
    const hint = (e as { hint?: unknown } | undefined)?.hint;
    if (typeof hint === 'string' && hint) errLine(`hint: ${hint}`);
  };
  try {
    // 1. Which vendor CLIs are installed.
    out('\n== 1. Vendor CLIs on this computer ==');
    for (const adapter of iron.registry.list()) {
      const lane = adapter.lanes.cli;
      if (!(lane instanceof CliLane)) continue;
      const path = await lane.findBinary();
      const official = CLI_SPECS.find((s) => s.provider === adapter.id)?.binary ?? lane.spec.binary;
      if (path) out(`  ${official.padEnd(7)} installed   (${adapter.id})`);
      else out(`  ${official.padEnd(7)} missing     (${adapter.id})  ${installHint(official)}`);
    }

    // 2. Existing logins.
    out('\n== 2. Existing logins ==');
    const found = await iron.discoverLogins();
    const usable = found.filter((f) => f.status === 'ok' && !f.adoptedProfileId);
    if (!usable.length) out('  No new signed-in vendor CLI logins found.');
    for (const f of usable) {
      const take = yes || isYes(await ask(`Use "${f.suggestedTitle}" as an account? [Y/n] `), true);
      if (!take) continue;
      try {
        const p = await iron.adoptLogin({
          provider: f.provider,
          home: f.home,
          title: f.suggestedTitle,
        });
        out(`  Added "${p.title}" (${p.provider}), using ${f.home} as-is.`);
      } catch (e) {
        report(e);
      }
    }

    // 3. More accounts.
    if (!yes) {
      out('\n== 3. More accounts ==');
      while (isYes(await ask('Add another account? [y/N] '), false)) {
        try {
          await addAccount(iron, ask, out, errLine);
        } catch (e) {
          report(e);
        }
      }
    }

    // 4. Summary.
    out(`\n== ${yes ? 3 : 4}. Your accounts ==`);
    await status(iron, io, false);
    const first = (await iron.listProfiles())[0];
    out(`\nYou're set. Try: iron-proxy chat ${first?.provider ?? 'anthropic'} "hello"`);
    return 0;
  } finally {
    own?.close();
  }
}

async function addAccount(
  iron: IronProxy,
  ask: Ask,
  out: (s: string) => void,
  errLine: (s: string) => void,
): Promise<void> {
  const adapters = iron.registry.list();
  const provider = await choose(
    ask,
    out,
    'Provider',
    adapters.map((a) => ({ value: a.id, label: `${a.id.padEnd(17)} ${a.displayName}` })),
  );
  const offered = Object.keys(iron.registry.get(provider).lanes).filter(
    (l): l is 'cli' | 'api-key' => l === 'cli' || l === 'api-key',
  );
  if (!offered.length)
    throw new IronProxyError('UNSUPPORTED', `Provider "${provider}" has no lane setup can add.`);
  const lane =
    offered.length === 1
      ? offered[0]!
      : await choose(
          ask,
          out,
          'Sign in with',
          offered.map((l) => ({
            value: l,
            label:
              l === 'cli'
                ? 'cli      your subscription, through the vendor CLI'
                : 'api-key  an API key',
          })),
        );
  const taken = new Set((await iron.listProfiles()).map((p) => p.title));
  const suggested = freeTitle(
    `${PROVIDER_SHORT_NAMES[provider]} (${lane === 'cli' ? 'subscription' : 'API key'})`,
    taken,
  );
  const title = (await ask(`Title [${suggested}]: `)).trim() || suggested;

  if (lane === 'api-key') {
    let baseUrl: string | undefined;
    if (provider === 'openai-compatible') {
      baseUrl = (await ask("Base URL (the server's /v1 URL): ")).trim();
      if (!baseUrl) throw new IronProxyError('INVALID_REQUEST', 'No base URL given.');
    }
    const key = (await ask('API key (not shown): ', { secret: true })).trim();
    if (!key)
      throw new IronProxyError('INVALID_REQUEST', 'No API key given.', {
        hint: 'Add it later: iron-proxy profiles add --lane api-key --api-key-stdin.',
      });
    const p = await iron.createProfile({
      title,
      provider,
      lane,
      apiKeySecret: key,
      ...(baseUrl ? { apiKey: { secretRef: '', baseUrl } } : {}),
    });
    out(`  Added "${p.title}" (${p.provider}, API key stored in the vault).`);
    return;
  }

  const p = await iron.createProfile({ title, provider, lane });
  out(`  Added "${p.title}" (${p.provider}). Signing in...`);
  const info = await iron.loginCommand(p.id);
  if (info.requiresTerminal) {
    await printTerminalLogin(iron, p.id, out);
    return;
  }
  await headlessLogin(iron, p.id, out, errLine);
}

/** Compact count: 950, 1.2k, 3.4M. */
export function compactNumber(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function windowCell(w: UsageWindowTotals): string {
  const tokens = w.inputTokens + w.outputTokens;
  return `${w.requests} req, ${compactNumber(tokens)} tok`;
}

/** 'about 40 min left at this pace', with '(rough)' for a low-confidence estimate. */
export function estimateLine(r: UsageReport): string {
  if (!r.estimate) return '';
  return `about ${r.estimate.minutesLeft} min left at this pace${r.estimate.confidence === 'low' ? ' (rough)' : ''}`;
}

async function usage(
  iron: IronProxy,
  io: CliIo,
  json: boolean,
  profileId: string | undefined,
): Promise<number> {
  const reports = await iron.usageReport(profileId ? { profileId } : {});
  const out = (s: string) => io.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  if (json) {
    out(JSON.stringify(reports, null, 2));
    return 0;
  }
  if (!reports.length) {
    out('No accounts yet. Add one with iron-proxy setup.');
    return 0;
  }
  const profiles = new Map((await iron.listProfiles()).map((p) => [p.id, p]));
  const rows = reports.map((r) => {
    const p = profiles.get(r.profileId);
    return [
      p?.title ?? r.profileId,
      p?.provider ?? '',
      windowCell(r.windows['5h']),
      windowCell(r.windows['24h']),
      windowCell(r.windows['7d']),
      String(r.parks7d),
      estimateLine(r),
    ];
  });
  out(table(['title', 'provider', '5h', '24h', '7d', 'parks this week', 'pace'], rows));
  return 0;
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
