import { mkdir } from 'node:fs/promises';
import type {
  LoginEvent,
  LoginSession,
  Profile,
  ProviderId,
  StreamEvent,
  UnifiedRequest,
  Usage,
} from '../../types.js';
import { CliError, IronProxyError, ProviderError } from '../../errors.js';
import { detectFromCliOutput } from '../../quota/detect.js';
import { newId, redactSecrets } from '../../util.js';
import type { Vault } from '../../vault/vault.js';
import { LaneQuotaSignal, type AttemptContext, type Lane, type LaneResponse } from '../types.js';
import { baseEnv, run, spawnLines, which, type RunResult } from './runner.js';

/** What a spec's line parser can report. */
export type CliParsed =
  | { kind: 'text'; delta: string } // incremental text
  | { kind: 'final'; text: string } // whole assistant text (when no deltas were streamed)
  | { kind: 'usage'; usage: Usage }
  | { kind: 'error'; text: string }
  | { kind: 'ignore' };

export interface CliRunInput {
  prompt: string;
  system?: string;
  model?: string;
}

/** Everything Iron-Proxy needs to know about one vendor CLI. */
export interface CliSpec {
  provider: ProviderId;
  displayName: string;
  binary: string;
  /** Environment variable the CLI honours for its home / config directory. */
  homeEnv: string;
  /** Env vars removed so the CLI never bypasses the subscription with an inherited API key. */
  stripEnv: string[];
  /** Arguments for one headless turn, tools off. */
  run(input: CliRunInput): { args: string[]; stdin?: string };
  /** Parse one line of stdout. Return several results when a line carries several facts. */
  parseLine(line: string, state: Record<string, unknown>): CliParsed[];
  /** Interactive login. `headless` variants print a URL and code instead of opening a browser. */
  login: { args: string[]; headlessArgs?: string[]; requiresTerminal?: boolean };
  logoutArgs?: string[];
  /** Cheap authentication check. */
  status?: { args: string[]; interpret(result: RunResult): 'ok' | 'unauthenticated' | 'unknown' };
  modelsArgs?: string[];
  /** Turn the models command output into ids. */
  parseModels?(stdout: string): string[];
  /** Files/dirs created inside a fresh home before first login, if the CLI needs any. */
  prepareHome?(home: string): Promise<void>;
}

/** Flatten a unified conversation into a single prompt for an agent CLI. */
export function renderPrompt(req: UnifiedRequest): { prompt: string; system: string | undefined } {
  const system = req.system;
  const turns = req.messages.filter((m) => m.role !== 'system');
  const text = (m: (typeof turns)[number]) =>
    m.content
      .map((p) => {
        switch (p.type) {
          case 'text':
            return p.text;
          case 'tool_call':
            return `[tool call ${p.name}(${JSON.stringify(p.arguments)})]`;
          case 'tool_result':
            return `[tool result ${p.toolCallId}: ${p.content}]`;
          case 'image':
          case 'image_url':
            return '[image omitted: vendor CLI lane accepts text only]';
        }
      })
      .join('\n');
  const last = turns[turns.length - 1];
  if (turns.length === 1 && last?.role === 'user') return { prompt: text(last), system };
  const lines: string[] = [
    'The following is the conversation so far. Continue it by replying as the assistant to the final user message. Reply with the assistant message only.',
    '',
  ];
  for (const m of turns)
    lines.push(
      `${m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User'}: ${text(m)}`,
      '',
    );
  return { prompt: lines.join('\n').trimEnd(), system };
}

export class CliLane implements Lane {
  readonly kind = 'cli' as const;
  constructor(readonly spec: CliSpec) {}

  /** Resolve executable + leading args. A `.js`/`.mjs` binary is run through the current Node. */
  private exe(profile: Profile): { binary: string; lead: string[] } {
    const bin = profile.cli?.binary ?? this.spec.binary;
    if (/\.(m?js|cjs)$/i.test(bin)) return { binary: process.execPath, lead: [bin] };
    return { binary: bin, lead: [] };
  }

  env(profile: Profile): Record<string, string> {
    if (!profile.cli?.home)
      throw new CliError('CLI_FAILED', `Profile "${profile.title}" has no CLI home directory.`);
    const env = baseEnv({ [this.spec.homeEnv]: profile.cli.home, ...(profile.cli.env ?? {}) });
    for (const k of this.spec.stripEnv) delete env[k];
    return env;
  }

  /** The exact command a host could run in a terminal to log this profile in. */
  loginCommand(
    profile: Profile,
    headless = false,
  ): { binary: string; args: string[]; env: Record<string, string> } {
    const { binary, lead } = this.exe(profile);
    const args =
      headless && this.spec.login.headlessArgs
        ? this.spec.login.headlessArgs
        : this.spec.login.args;
    return { binary, args: [...lead, ...args], env: this.env(profile) };
  }

  async ensureHome(profile: Profile): Promise<void> {
    if (!profile.cli?.home) return;
    await mkdir(profile.cli.home, { recursive: true });
    await this.spec.prepareHome?.(profile.cli.home);
  }

  async complete(req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse> {
    let text = '';
    let usage: Usage | undefined;
    let id = newId('cli');
    for await (const ev of this.stream(req, ctx)) {
      if (ev.type === 'start') id = ev.id;
      else if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'usage') usage = ev.usage;
    }
    const out: LaneResponse = {
      id,
      model: req.model ?? ctx.profile.defaultModel ?? this.spec.displayName,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      finishReason: 'stop',
    };
    if (usage) out.usage = usage;
    return out;
  }

  async *stream(req: UnifiedRequest, ctx: AttemptContext): AsyncIterable<StreamEvent> {
    const { prompt, system } = renderPrompt(req);
    const model = req.model ?? ctx.profile.defaultModel;
    const built = this.spec.run({
      prompt,
      ...(system ? { system } : {}),
      ...(model ? { model } : {}),
    });
    const { binary, lead } = this.exe(ctx.profile);
    await this.ensureHome(ctx.profile);
    const proc = spawnLines({
      binary,
      args: [...lead, ...built.args],
      env: this.env(ctx.profile),
      ...(built.stdin !== undefined ? { stdin: built.stdin } : {}),
      signal: ctx.signal,
      cwd: ctx.profile.cli!.home,
    });

    const state: Record<string, unknown> = {};
    let started = false;
    let streamedText = '';
    let finalText: string | undefined;
    let usage: Usage | undefined;
    const errors: string[] = [];
    const stderr: string[] = [];
    const id = newId('cli');

    const start = (): StreamEvent => {
      started = true;
      return {
        type: 'start',
        id,
        model: model ?? this.spec.displayName,
        provider: this.spec.provider,
        profileId: ctx.profile.id,
      };
    };

    for await (const { source, line } of proc.lines) {
      if (source === 'stderr') {
        stderr.push(line);
        continue;
      }
      for (const parsed of this.spec.parseLine(line, state)) {
        switch (parsed.kind) {
          case 'text':
            if (!started) {
              // A quota message can arrive as ordinary text before anything else.
              const sig = detectFromCliOutput(this.spec.provider, parsed.delta, ctx.now());
              if (sig && !streamedText) {
                proc.kill();
                throw new LaneQuotaSignal(sig);
              }
              yield start();
            }
            streamedText += parsed.delta;
            yield { type: 'text', delta: parsed.delta };
            break;
          case 'final':
            finalText = parsed.text;
            break;
          case 'usage':
            usage = parsed.usage;
            break;
          case 'error':
            errors.push(parsed.text);
            break;
          case 'ignore':
            break;
        }
      }
    }
    const exit = await proc.exit;

    const errorText = [...errors, ...stderr].join('\n');
    if (errorText) {
      const sig = detectFromCliOutput(this.spec.provider, errorText, ctx.now());
      if (sig && !streamedText) throw new LaneQuotaSignal(sig);
    }
    if (!streamedText && finalText !== undefined) {
      const sig = detectFromCliOutput(this.spec.provider, finalText, ctx.now());
      if (sig && (exit.code ?? 0) !== 0) throw new LaneQuotaSignal(sig);
    }

    if (!started) {
      if ((exit.code ?? 0) !== 0 && finalText === undefined) {
        throw new ProviderError(
          `${this.spec.displayName} exited with code ${exit.code}: ${redactSecrets(errorText || '(no output)').slice(0, 500)}`,
          { details: { code: exit.code } },
        );
      }
      yield start();
    }
    if (!streamedText && finalText) yield { type: 'text', delta: finalText };
    if (
      streamedText &&
      finalText &&
      finalText.length > streamedText.length &&
      finalText.startsWith(streamedText)
    ) {
      // The CLI printed a final message longer than the deltas we saw; emit the tail.
      yield { type: 'text', delta: finalText.slice(streamedText.length) };
    }
    if (usage) yield { type: 'usage', usage };
    if (started && (exit.code ?? 0) !== 0 && !streamedText && !finalText) {
      throw new ProviderError(
        `${this.spec.displayName} exited with code ${exit.code}: ${redactSecrets(errorText).slice(0, 500)}`,
      );
    }
    yield { type: 'finish', finishReason: 'stop' };
  }

  async checkAuth(profile: Profile): Promise<'ok' | 'unauthenticated' | 'unknown'> {
    if (!this.spec.status) return 'unknown';
    const { binary, lead } = this.exe(profile);
    if (!(await which(binary))) return 'unknown';
    await this.ensureHome(profile);
    try {
      const result = await run({
        binary,
        args: [...lead, ...this.spec.status.args],
        env: this.env(profile),
        timeoutMs: 20_000,
        cwd: profile.cli!.home,
      });
      return this.spec.status.interpret(result);
    } catch {
      return 'unknown';
    }
  }

  login(profile: Profile, _vault: Vault, opts: { headless?: boolean } = {}): LoginSession {
    if (this.spec.login.requiresTerminal) {
      throw new IronProxyError(
        'UNSUPPORTED',
        `${this.spec.displayName} signs in interactively. Run loginCommand() in a terminal window instead.`,
        { details: { provider: this.spec.provider, requiresTerminal: true } },
      );
    }
    const listeners = new Set<(e: LoginEvent) => void>();
    const emit = (e: LoginEvent) => {
      for (const l of listeners) l(e);
    };
    const controller = new AbortController();
    const cmd = this.loginCommand(profile, opts.headless ?? true);
    const method = (opts.headless ?? true) ? 'cli-headless' : 'cli';

    const done = (async () => {
      await this.ensureHome(profile);
      emit({ type: 'started', profileId: profile.id, method });
      const proc = spawnLines({
        ...cmd,
        signal: controller.signal,
        timeoutMs: 15 * 60_000,
        cwd: profile.cli!.home,
      });
      const seenUrls = new Set<string>();
      const seenCodes = new Set<string>();
      for await (const { line } of proc.lines) {
        const clean = redactSecrets(line);
        emit({ type: 'output', profileId: profile.id, line: clean });
        for (const m of clean.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
          if (!seenUrls.has(m[0])) {
            seenUrls.add(m[0]);
            emit({ type: 'url', profileId: profile.id, url: m[0] });
          }
        }
        const code =
          /\b(?:code|enter)\b[^A-Z0-9]*([A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+|[A-Z0-9]{6,9})\b/i.exec(
            clean,
          );
        if (code?.[1] && !seenCodes.has(code[1]) && !/^https?/i.test(code[1])) {
          seenCodes.add(code[1]);
          emit({ type: 'code', profileId: profile.id, code: code[1] });
        }
      }
      const exit = await proc.exit;
      if (controller.signal.aborted) {
        emit({ type: 'cancelled', profileId: profile.id });
        throw new CliError('CLI_FAILED', 'Login cancelled.');
      }
      const status = await this.checkAuth(profile);
      if ((exit.code ?? 0) === 0 && status !== 'unauthenticated') {
        emit({ type: 'completed', profileId: profile.id });
        return;
      }
      const message = `Login did not complete (exit ${exit.code}, status ${status}).`;
      emit({ type: 'failed', profileId: profile.id, message });
      throw new CliError('CLI_FAILED', message, { code: exit.code, status });
    })();
    done.catch(() => {});

    return {
      profileId: profile.id,
      done,
      cancel: () => controller.abort(),
      on: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
  }

  async logout(profile: Profile): Promise<void> {
    if (!this.spec.logoutArgs) return;
    const { binary, lead } = this.exe(profile);
    await run({
      binary,
      args: [...lead, ...this.spec.logoutArgs],
      env: this.env(profile),
      timeoutMs: 30_000,
      cwd: profile.cli!.home,
    }).catch(() => {});
  }

  async listModels(profile: Profile): Promise<string[]> {
    if (!this.spec.modelsArgs || !this.spec.parseModels) return [];
    const { binary, lead } = this.exe(profile);
    const r = await run({
      binary,
      args: [...lead, ...this.spec.modelsArgs],
      env: this.env(profile),
      timeoutMs: 30_000,
      cwd: profile.cli!.home,
    }).catch(() => undefined);
    return r ? this.spec.parseModels(r.stdout) : [];
  }
}
