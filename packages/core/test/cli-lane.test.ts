import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliLane, renderPrompt } from '../src/adapters/cli/lane.js';
import { claudeSpec, codexSpec, geminiSpec, grokSpec } from '../src/adapters/cli/specs.js';
import { LaneQuotaSignal, type AttemptContext } from '../src/adapters/types.js';
import type { Profile, StreamEvent, UnifiedRequest } from '../src/types.js';
import { MemoryVault } from '../src/vault/vault.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli/fake-cli.mjs', import.meta.url));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const specs = { claude: claudeSpec, codex: codexSpec, grok: grokSpec, gemini: geminiSpec } as const;

function profile(flavor: keyof typeof specs, mode = 'ok'): Profile {
  return {
    id: `p-${flavor}`,
    title: flavor,
    provider: specs[flavor].provider,
    lane: 'cli',
    order: 0,
    enabled: true,
    cli: {
      home: join(dir, flavor),
      binary: FAKE,
      env: { FAKE_CLI_FLAVOR: flavor, FAKE_CLI_MODE: mode },
    },
    createdAt: 'x',
    updatedAt: 'x',
  };
}

function ctx(p: Profile): AttemptContext {
  return {
    profile: p,
    vault: new MemoryVault(),
    fetch,
    signal: new AbortController().signal,
    now: () => Date.now(),
    reportUsage: () => {},
  };
}

const req: UnifiedRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }],
};

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('renderPrompt', () => {
  it('passes a single user message through and transcribes multi-turn', () => {
    expect(renderPrompt(req).prompt).toBe('hello there');
    const multi = renderPrompt({
      system: 'S',
      messages: [
        ...req.messages,
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
    });
    expect(multi.system).toBe('S');
    expect(multi.prompt).toContain('User: hello there');
    expect(multi.prompt).toContain('Assistant: hi');
    expect(multi.prompt.endsWith('User: again')).toBe(true);
  });
});

/** Sign the fake account in: headless login where the CLI has one, otherwise drop the marker like a terminal login would. */
async function signIn(lane: CliLane, p: Profile) {
  if (lane.spec.login.requiresTerminal) {
    await lane.ensureHome(p);
    await writeFile(join(p.cli!.home, 'logged-in'), 'yes');
    return;
  }
  await lane.login(p, new MemoryVault()).done;
}

describe.each(Object.keys(specs) as Array<keyof typeof specs>)('CliLane via fake %s', (flavor) => {
  it('logs in headlessly, surfaces the URL and code, then answers with the isolated home', async () => {
    const lane = new CliLane(specs[flavor]);
    const p = profile(flavor);
    expect(await lane.checkAuth(p)).toBe('unauthenticated');

    if (lane.spec.login.requiresTerminal) {
      expect(() => lane.login(p, new MemoryVault())).toThrow(/terminal/);
      await signIn(lane, p);
    } else {
      const session = lane.login(p, new MemoryVault());
      const seen: string[] = [];
      session.on((e) =>
        seen.push(
          e.type + (e.type === 'url' ? ':' + e.url : e.type === 'code' ? ':' + e.code : ''),
        ),
      );
      await session.done;
      expect(seen).toContain('url:https://example.test/device');
      expect(seen).toContain('code:ABCD-1234');
      expect(seen.at(-1)).toBe('completed');
    }
    expect(await lane.checkAuth(p)).toBe('ok');

    const res = await lane.complete(req, ctx(p));
    expect(res.message.content[0]).toEqual({ type: 'text', text: 'echo:hello there' });
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

    const inv = JSON.parse(await readFile(join(p.cli!.home, 'last-invocation.json'), 'utf8')) as {
      env: Record<string, string | null>;
    };
    expect(inv.env[specs[flavor].homeEnv]).toBe(p.cli!.home);
    expect(inv.env.ANTHROPIC_API_KEY).toBeNull();
  });

  it('streams text deltas', async () => {
    const lane = new CliLane(specs[flavor]);
    const p = profile(flavor);
    await signIn(lane, p);
    const evs = await collect(lane.stream(req, ctx(p)));
    expect(evs[0]?.type).toBe('start');
    const text = evs
      .filter((e) => e.type === 'text')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text).toBe('echo:hello there');
    expect(evs.at(-1)?.type).toBe('finish');
  });

  it('turns a usage-limit message into a LaneQuotaSignal with a reset time', async () => {
    const lane = new CliLane(specs[flavor]);
    const p = profile(flavor, 'quota');
    await signIn(lane, p);
    const err = await lane.complete(req, ctx(p)).catch((e) => e);
    expect(err).toBeInstanceOf(LaneQuotaSignal);
    expect((err as LaneQuotaSignal).signal.kind).toBe('quota-exhausted');
    expect((err as LaneQuotaSignal).signal.resetAt).toBeDefined();
  });

  it('turns a not-logged-in message into an auth-expired signal', async () => {
    const lane = new CliLane(specs[flavor]);
    const p = profile(flavor, 'auth');
    const err = await lane.complete(req, ctx(p)).catch((e) => e);
    expect(err).toBeInstanceOf(LaneQuotaSignal);
    expect((err as LaneQuotaSignal).signal.kind).toBe('auth-expired');
  });

  it('logout removes the credential', async () => {
    const lane = new CliLane(specs[flavor]);
    const p = profile(flavor);
    await signIn(lane, p);
    if (lane.spec.logoutArgs) {
      await lane.logout(p);
      expect(await lane.checkAuth(p)).toBe('unauthenticated');
    }
  });
});

describe('CliLane errors', () => {
  it('reports overload as a quota signal and a crash as a provider error', async () => {
    const lane = new CliLane(claudeSpec);
    const p = profile('claude', 'overload');
    await writeFile(join(p.cli!.home, 'logged-in'), 'yes').catch(async () => {
      await lane.ensureHome(p);
      await writeFile(join(p.cli!.home, 'logged-in'), 'yes');
    });
    const err = await lane.complete(req, ctx(p)).catch((e) => e);
    expect(err).toBeInstanceOf(LaneQuotaSignal);
    expect((err as LaneQuotaSignal).signal.kind).toBe('overloaded');

    const crash = profile('claude', 'crash');
    await lane.ensureHome(crash);
    await writeFile(join(crash.cli!.home, 'logged-in'), 'yes');
    const e2 = await lane.complete(req, ctx(crash)).catch((e) => e);
    expect(e2).not.toBeInstanceOf(LaneQuotaSignal);
    expect(String(e2.message)).toMatch(/exited with code/);
  });

  it('a missing binary is CLI_NOT_FOUND', async () => {
    const lane = new CliLane({ ...claudeSpec, binary: 'definitely-not-a-real-binary-xyz' });
    const p = profile('claude');
    delete p.cli!.binary;
    await lane.ensureHome(p);
    const err = await lane.complete(req, ctx(p)).catch((e) => e);
    expect(err.code).toBe('CLI_NOT_FOUND');
  });

  it('exposes the login command a host can run in a terminal', () => {
    const lane = new CliLane(grokSpec);
    const cmd = lane.loginCommand(profile('grok'), false);
    expect(cmd.args.slice(-2)).toEqual(['login', '--oauth']);
    expect(cmd.env.GROK_HOME).toBe(join(dir, 'grok'));
    expect(lane.loginCommand(profile('grok'), true).args.slice(-2)).toEqual([
      'login',
      '--device-auth',
    ]);
  });
});
