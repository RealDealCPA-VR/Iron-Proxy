import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliLane } from '../src/adapters/cli/lane.js';
import { claudeSpec, codexSpec, geminiSpec, grokSpec } from '../src/adapters/cli/specs.js';
import {
  AdapterRegistry,
  LaneQuotaSignal,
  type AttemptContext,
  type Lane,
  type LaneResponse,
} from '../src/adapters/types.js';
import {
  AuthRequiredError,
  CLI_INSTALL_HINTS,
  CliError,
  DEFAULT_HINTS,
  IronProxyError,
  installHint,
  serializeError,
  type ErrorCode,
} from '../src/errors.js';
import { createIronProxy, type IronProxy } from '../src/manager.js';
import type { Profile, StreamEvent, UnifiedRequest } from '../src/types.js';
import { FileVault, MemoryVault, type KeyProtector } from '../src/vault/vault.js';

type Script = 'quota' | 'auth' | 'hang' | 'mid-stream' | 'ok';

/** An api-key lane whose behaviour is chosen per profile title. */
class ScriptLane implements Lane {
  readonly kind = 'api-key' as const;
  private run(ctx: AttemptContext): Promise<void> {
    const s = ctx.profile.title.split(':')[0] as Script;
    if (s === 'quota')
      throw new LaneQuotaSignal({
        kind: 'rate-limit',
        source: 'header',
        resetAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    if (s === 'auth') throw new AuthRequiredError(ctx.profile.id, 'token expired');
    if (s === 'hang')
      return new Promise((_, reject) =>
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }),
      );
    return Promise.resolve();
  }
  async complete(_req: UnifiedRequest, ctx: AttemptContext): Promise<LaneResponse> {
    await this.run(ctx);
    return {
      id: 'r',
      model: 'm',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      finishReason: 'stop',
    };
  }
  async *stream(_req: UnifiedRequest, ctx: AttemptContext): AsyncIterable<StreamEvent> {
    const midStream = ctx.profile.title.startsWith('mid-stream');
    if (!midStream) await this.run(ctx);
    yield { type: 'start', id: 'r', model: 'm', provider: 'anthropic', profileId: ctx.profile.id };
    yield { type: 'text', delta: 'partial' };
    if (midStream) throw new LaneQuotaSignal({ kind: 'rate-limit', source: 'header' });
    yield { type: 'finish', finishReason: 'stop' };
  }
  async checkAuth() {
    return 'ok' as const;
  }
}

let dir: string;
let iron: IronProxy;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-hints-'));
  const registry = new AdapterRegistry().register({
    id: 'anthropic',
    displayName: 'A',
    defaultModel: 'm',
    lanes: { 'api-key': new ScriptLane() },
  });
  iron = createIronProxy({
    dataDir: dir,
    registry,
    vault: new MemoryVault(),
    policy: { overloadRetries: 0 },
  });
});
afterEach(async () => {
  await iron.close();
  await rm(dir, { recursive: true, force: true });
});

const req: UnifiedRequest = {
  model: 'claude-x',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

async function only(title: string): Promise<Profile> {
  for (const p of await iron.listProfiles()) await iron.deleteProfile(p.id);
  return iron.createProfile({ title, provider: 'anthropic', lane: 'api-key' });
}

async function streamError(title: string) {
  await only(title);
  for await (const ev of iron.stream(req)) if (ev.type === 'error') return ev.error;
  throw new Error('no error event');
}

const cliProfile = (binary?: string): Profile => ({
  id: 'p-cli',
  title: 'cli',
  provider: 'anthropic',
  lane: 'cli',
  order: 0,
  enabled: true,
  cli: { home: join(dir, 'h'), ...(binary ? { binary } : {}) },
  createdAt: 'x',
  updatedAt: 'x',
});

/** Each row raises the error through the code path the library really uses. */
const cases: Array<[ErrorCode, () => Promise<unknown>, RegExp]> = [
  [
    'NO_PROFILE',
    () => iron.complete(req),
    /Add a anthropic account: iron-proxy profiles add --provider anthropic .*'Add account' in the switcher/,
  ],
  ['PROFILE_NOT_FOUND', () => iron.getProfile('nope'), /iron-proxy profiles list/],
  [
    'AUTH_REQUIRED',
    async () => {
      await only('auth: Work Claude');
      return iron.complete(req);
    },
    /Enter the API key for "auth: Work Claude" again/,
  ],
  [
    'ALL_PROFILES_EXHAUSTED',
    async () => {
      await only('quota');
      return iron.complete(req);
    },
    /Wait until .+ for the first reset, or add another anthropic account/,
  ],
  [
    'QUOTA_EXCEEDED',
    async () => {
      const p = await only('quota');
      return iron.complete(req, { profileId: p.id, strict: true });
    },
    /pinned with strict.*wait for the reset \(it resets at .+\).*next anthropic account/,
  ],
  [
    'CLI_NOT_FOUND',
    () =>
      new CliLane({ ...claudeSpec, binary: 'claude-not-installed-xyz' }).complete(req, {
        profile: cliProfile(),
        vault: new MemoryVault(),
        fetch,
        signal: new AbortController().signal,
        now: () => Date.now(),
        reportUsage: () => {},
      }),
    /Install "claude-not-installed-xyz" and put it on PATH/,
  ],
  [
    'CLI_FAILED',
    async () => {
      const { cli: _home, ...noHome } = cliProfile();
      return new CliLane(claudeSpec).env(noHome);
    },
    /iron-proxy profiles remove p-cli/,
  ],
  [
    'VAULT_ERROR',
    async () => {
      const xor: KeyProtector = {
        label: 'xor-test',
        protect: async (k) => Buffer.from(k.map((b) => b ^ 0x5a)),
        unprotect: async (k) => Buffer.from(k.map((b) => b ^ 0x5a)),
      };
      await new FileVault(join(dir, 'v'), xor).set('x', 'y');
      return new FileVault(join(dir, 'v')).get('x');
    },
    /Wrong key protector: start Iron-Proxy with the "xor-test" protector/,
  ],
  [
    'INVALID_REQUEST',
    () => iron.createProfile({ title: 'x', provider: 'nope' as 'anthropic', lane: 'api-key' }),
    /Use one of: anthropic, openai/,
  ],
  [
    'TIMEOUT',
    async () => {
      await only('hang');
      return iron.complete(req, { timeoutMs: 20 });
    },
    /raise requestTimeoutMs/,
  ],
];

describe('actionable hints', () => {
  it.each(cases)('%s carries a hint', async (code, raise, pattern) => {
    const err = await Promise.resolve()
      .then(raise)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err, `${code} was not raised`).toBeInstanceOf(IronProxyError);
    const e = err as IronProxyError;
    expect(e.code).toBe(code);
    expect(e.hint).toMatch(pattern);
    expect(e.toJSON().hint).toBe(e.hint);
    expect(serializeError(e).hint).toBe(e.hint);
  });

  it('STREAM_INTERRUPTED says to resend', async () => {
    const err = await streamError('mid-stream');
    expect(err.code).toBe('STREAM_INTERRUPTED');
    expect(err.hint).toBe('Resend; the next account will take it.');
  });

  it('every error code has a default hint', () => {
    const codes: ErrorCode[] = [
      'NO_PROFILE',
      'PROFILE_NOT_FOUND',
      'PROVIDER_MISMATCH',
      'AUTH_REQUIRED',
      'QUOTA_EXCEEDED',
      'ALL_PROFILES_EXHAUSTED',
      'PROVIDER_ERROR',
      'CLI_NOT_FOUND',
      'CLI_FAILED',
      'VAULT_ERROR',
      'INVALID_REQUEST',
      'TIMEOUT',
      'ABORTED',
      'STREAM_INTERRUPTED',
      'UNSUPPORTED',
    ];
    for (const code of codes) {
      expect(DEFAULT_HINTS[code].length).toBeGreaterThan(10);
      expect(new IronProxyError(code, 'x').hint).toBe(DEFAULT_HINTS[code]);
    }
  });

  it('CLI_NOT_FOUND names the official install command for each vendor CLI', async () => {
    expect(installHint('claude')).toContain('npm install -g @anthropic-ai/claude-code');
    expect(installHint('codex')).toContain('npm install -g @openai/codex');
    expect(installHint('gemini')).toContain('npm install -g @google/gemini-cli');
    expect(installHint('grok')).toBe('Install Grok Build from xAI, then run grok --version');
    expect(installHint('C:\\tools\\claude.exe')).toBe(CLI_INSTALL_HINTS.claude);
    expect(installHint('/usr/local/bin/codex')).toBe(CLI_INSTALL_HINTS.codex);
    for (const spec of [claudeSpec, codexSpec, geminiSpec, grokSpec]) {
      const e = new CliError('CLI_NOT_FOUND', 'x', { binary: spec.binary });
      expect(e.hint).toBe(CLI_INSTALL_HINTS[spec.binary]);
    }
  });

  it('never carries secrets or emails', () => {
    const cli = new AuthRequiredError('p1', 'expired', { title: 'Work Claude', lane: 'cli' });
    expect(cli.hint).toBe(
      'Log "Work Claude" in again: iron-proxy login p1, or \'Log in\' on it in the switcher.',
    );
    const e = new AuthRequiredError('p1', 'expired', { title: 'me@example.com Claude' });
    expect(e.hint).not.toContain('me@example.com');
    expect(e.hint).toContain('[email]');
    const k = new IronProxyError('INVALID_REQUEST', 'x', {
      hint: 'Use sk-ant-abcdefghijklmnopqrstuvwxyz0123 instead',
    });
    expect(k.hint).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });
});
