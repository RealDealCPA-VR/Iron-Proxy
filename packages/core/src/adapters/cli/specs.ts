import type { Usage } from '../../types.js';
import type { CliParsed, CliSpec } from './lane.js';

function tryJson(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function pick<T = unknown>(obj: unknown, path: string[]): T | undefined {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur as T | undefined;
}

function usageFrom(u: unknown): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const r = u as Record<string, unknown>;
  const out: Usage = {};
  const inp = r.input_tokens ?? r.inputTokens ?? r.prompt_tokens;
  const outp = r.output_tokens ?? r.outputTokens ?? r.completion_tokens;
  const cr = r.cache_read_input_tokens ?? r.cached_input_tokens ?? r.cached_tokens;
  const cw = r.cache_creation_input_tokens;
  if (typeof inp === 'number') out.inputTokens = inp;
  if (typeof outp === 'number') out.outputTokens = outp;
  if (typeof cr === 'number') out.cacheReadTokens = cr;
  if (typeof cw === 'number') out.cacheWriteTokens = cw;
  return Object.keys(out).length ? out : undefined;
}

const COMMON_STRIP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
];

/* ------------------------------------------------------------------ */
/* Claude Code                                                         */
/* ------------------------------------------------------------------ */

export const claudeSpec: CliSpec = {
  provider: 'anthropic',
  displayName: 'Claude Code',
  binary: 'claude',
  homeEnv: 'CLAUDE_CONFIG_DIR',
  stripEnv: COMMON_STRIP,
  run({ prompt, system, model }) {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--max-turns',
      '1',
      '--no-session-persistence',
      '--setting-sources',
      '',
    ];
    if (model) args.push('--model', model);
    if (system) args.push('--system-prompt', system);
    return { args };
  },
  parseLine(line) {
    const j = tryJson(line);
    if (!j) return line.trim() ? [{ kind: 'text', delta: line + '\n' }] : [];
    switch (j.type) {
      case 'stream_event': {
        const ev = j.event as Record<string, unknown> | undefined;
        if (ev?.type === 'content_block_delta') {
          const text = pick<string>(ev, ['delta', 'text']);
          if (typeof text === 'string' && pick(ev, ['delta', 'type']) === 'text_delta')
            return [{ kind: 'text', delta: text }];
        }
        return [{ kind: 'ignore' }];
      }
      case 'assistant': {
        const blocks = pick<Array<Record<string, unknown>>>(j, ['message', 'content']) ?? [];
        const text = blocks
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('');
        return text ? [{ kind: 'final', text }] : [{ kind: 'ignore' }];
      }
      case 'result': {
        const out: CliParsed[] = [];
        const u = usageFrom(j.usage);
        if (u) out.push({ kind: 'usage', usage: u });
        if (j.is_error)
          out.push({
            kind: 'error',
            text: String(j.result ?? j.error ?? 'Claude Code reported an error.'),
          });
        else if (typeof j.result === 'string' && j.result)
          out.push({ kind: 'final', text: j.result });
        return out.length ? out : [{ kind: 'ignore' }];
      }
      case 'error':
        return [{ kind: 'error', text: String(j.message ?? j.error ?? line) }];
      default:
        return [{ kind: 'ignore' }];
    }
  },
  login: { args: ['auth', 'login'], headlessArgs: ['auth', 'login'] },
  logoutArgs: ['auth', 'logout'],
  status: {
    args: ['auth', 'status'],
    interpret(r) {
      const j =
        tryJson(
          r.stdout
            .trim()
            .split('\n')
            .find((l) => l.trim().startsWith('{')) ?? '',
        ) ?? tryJson(r.stdout);
      if (j && typeof j.loggedIn === 'boolean') return j.loggedIn ? 'ok' : 'unauthenticated';
      if (/logged in|authenticated/i.test(r.stdout) && !/not logged in/i.test(r.stdout))
        return 'ok';
      if (/not logged in|no credentials/i.test(r.stdout + r.stderr)) return 'unauthenticated';
      return 'unknown';
    },
  },
};

/* ------------------------------------------------------------------ */
/* OpenAI Codex CLI                                                    */
/* ------------------------------------------------------------------ */

export const codexSpec: CliSpec = {
  provider: 'openai',
  displayName: 'Codex CLI',
  binary: 'codex',
  homeEnv: 'CODEX_HOME',
  stripEnv: COMMON_STRIP,
  run({ prompt, system, model }) {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color',
      'never',
      '-s',
      'read-only',
    ];
    if (model) args.push('-m', model);
    args.push('-');
    const stdin = system ? `<system>\n${system}\n</system>\n\n${prompt}` : prompt;
    return { args, stdin };
  },
  parseLine(line) {
    const j = tryJson(line);
    if (!j) return line.trim() ? [{ kind: 'text', delta: line + '\n' }] : [];
    const type = String(j.type ?? '');
    if (type === 'item.completed' || type === 'item.updated') {
      const item = j.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string')
        return [{ kind: 'final', text: item.text }];
      if (item?.type === 'error')
        return [{ kind: 'error', text: String(item.message ?? item.text ?? line) }];
      return [{ kind: 'ignore' }];
    }
    if (type === 'item.delta' || type === 'agent_message_delta' || type === 'message.delta') {
      const delta = (j.delta ?? pick(j, ['item', 'delta']) ?? j.text) as unknown;
      return typeof delta === 'string' ? [{ kind: 'text', delta }] : [{ kind: 'ignore' }];
    }
    if (type === 'turn.completed') {
      const u = usageFrom(j.usage);
      return u ? [{ kind: 'usage', usage: u }] : [{ kind: 'ignore' }];
    }
    if (type === 'turn.failed' || type === 'error') {
      const msg =
        pick<string>(j, ['error', 'message']) ?? (j.message as string | undefined) ?? line;
      return [{ kind: 'error', text: String(msg) }];
    }
    return [{ kind: 'ignore' }];
  },
  login: { args: ['login'], headlessArgs: ['login', '--device-auth'] },
  logoutArgs: ['logout'],
  status: {
    args: ['login', 'status'],
    interpret(r) {
      const all = r.stdout + '\n' + r.stderr;
      if (/not logged in|not authenticated|no credentials/i.test(all)) return 'unauthenticated';
      if (/logged in|authenticated|api key/i.test(all)) return 'ok';
      return r.code === 0 ? 'ok' : 'unknown';
    },
  },
};

/* ------------------------------------------------------------------ */
/* xAI Grok Build CLI                                                  */
/* ------------------------------------------------------------------ */

export const grokSpec: CliSpec = {
  provider: 'xai',
  displayName: 'Grok CLI',
  binary: 'grok',
  homeEnv: 'GROK_HOME',
  stripEnv: COMMON_STRIP,
  run({ prompt, system, model }) {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'streaming-messages-json',
      '--include-partial-messages',
      '--tools',
      '',
      '--max-turns',
      '1',
      '--permission-mode',
      'default',
    ];
    if (model) args.push('-m', model);
    if (system) args.push('--system-prompt-override', system);
    return { args };
  },
  parseLine(line) {
    const j = tryJson(line);
    if (!j) return line.trim() ? [{ kind: 'text', delta: line + '\n' }] : [];
    const type = String(j.type ?? '');
    if (type === 'stream_event') {
      const ev = j.event as Record<string, unknown> | undefined;
      const text =
        pick<string>(ev, ['delta', 'text']) ??
        (typeof ev?.text === 'string' ? (ev.text as string) : undefined);
      return typeof text === 'string' ? [{ kind: 'text', delta: text }] : [{ kind: 'ignore' }];
    }
    if (type === 'assistant' || j.role === 'assistant' || type === 'message') {
      const content = (pick(j, ['message', 'content']) ?? j.content) as unknown;
      if (typeof content === 'string') return [{ kind: 'final', text: content }];
      if (Array.isArray(content)) {
        const text = content
          .filter((b) => b && (b as { type?: string }).type === 'text')
          .map((b) => String((b as { text?: string }).text ?? ''))
          .join('');
        return text ? [{ kind: 'final', text }] : [{ kind: 'ignore' }];
      }
      return [{ kind: 'ignore' }];
    }
    if (type === 'result') {
      const out: CliParsed[] = [];
      const u = usageFrom(j.usage);
      if (u) out.push({ kind: 'usage', usage: u });
      if (j.is_error || j.error) out.push({ kind: 'error', text: String(j.result ?? j.error) });
      else if (typeof j.result === 'string' && j.result)
        out.push({ kind: 'final', text: j.result });
      return out.length ? out : [{ kind: 'ignore' }];
    }
    if (type === 'error') return [{ kind: 'error', text: String(j.message ?? j.error ?? line) }];
    return [{ kind: 'ignore' }];
  },
  login: { args: ['login', '--oauth'], headlessArgs: ['login', '--device-auth'] },
  logoutArgs: ['logout'],
  status: {
    args: ['models'],
    interpret(r) {
      const all = r.stdout + '\n' + r.stderr;
      if (/not authenticated|not logged in|please (?:log|sign) in/i.test(all))
        return 'unauthenticated';
      if (/available models/i.test(all) && r.code === 0) return 'ok';
      return 'unknown';
    },
  },
  modelsArgs: ['models'],
  parseModels(stdout) {
    return [...stdout.matchAll(/^\s*[*-]\s+([a-z0-9][\w.-]*)/gim)]
      .map((m) => m[1]!)
      .filter(Boolean);
  },
};

/* ------------------------------------------------------------------ */
/* Google Gemini CLI                                                   */
/* ------------------------------------------------------------------ */

export const geminiSpec: CliSpec = {
  provider: 'google',
  displayName: 'Gemini CLI',
  binary: 'gemini',
  homeEnv: 'GEMINI_CLI_HOME',
  stripEnv: COMMON_STRIP,
  run({ prompt, system, model }) {
    const args = [
      '-p',
      system ? `<system>\n${system}\n</system>\n\n${prompt}` : prompt,
      '--output-format',
      'stream-json',
      '--approval-mode',
      'default',
    ];
    if (model) args.push('-m', model);
    return { args };
  },
  parseLine(line) {
    const j = tryJson(line);
    if (!j) return line.trim() ? [{ kind: 'text', delta: line + '\n' }] : [];
    const type = String(j.type ?? '');
    if (type === 'message' && j.role === 'assistant') {
      const c = j.content;
      if (typeof c === 'string')
        return j.delta === true ? [{ kind: 'text', delta: c }] : [{ kind: 'final', text: c }];
      return [{ kind: 'ignore' }];
    }
    if (type === 'content' || type === 'text') {
      const t = (j.text ?? j.content ?? j.delta) as unknown;
      return typeof t === 'string' ? [{ kind: 'text', delta: t }] : [{ kind: 'ignore' }];
    }
    if (type === 'result') {
      const out: CliParsed[] = [];
      const u = usageFrom(j.usage ?? pick(j, ['stats', 'usage']));
      if (u) out.push({ kind: 'usage', usage: u });
      if (typeof j.response === 'string' && j.response)
        out.push({ kind: 'final', text: j.response });
      if (j.error)
        out.push({ kind: 'error', text: String(pick(j, ['error', 'message']) ?? j.error) });
      return out.length ? out : [{ kind: 'ignore' }];
    }
    if (type === 'error')
      return [{ kind: 'error', text: String(j.message ?? pick(j, ['error', 'message']) ?? line) }];
    return [{ kind: 'ignore' }];
  },
  // Gemini CLI has no login subcommand: the interactive app signs in on first run.
  login: { args: [], requiresTerminal: true },
  status: {
    args: ['-p', 'Reply with the single word OK.', '--output-format', 'json'],
    interpret(r) {
      const all = r.stdout + '\n' + r.stderr;
      if (/not (?:logged in|authenticated)|please (?:log|sign) in|auth/i.test(all) && r.code !== 0)
        return 'unauthenticated';
      return r.code === 0 ? 'ok' : 'unknown';
    },
  },
};

export const CLI_SPECS: readonly CliSpec[] = [claudeSpec, codexSpec, grokSpec, geminiSpec];
