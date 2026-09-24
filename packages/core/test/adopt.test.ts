import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultRegistry } from '../src/adapters/index.js';
import { CliLane } from '../src/adapters/cli/lane.js';
import { claudeSpec, codexSpec, geminiSpec, grokSpec } from '../src/adapters/cli/specs.js';
import { LocalIronClient, IRON_CLIENT_METHODS } from '../src/client.js';
import { IronProxyError } from '../src/errors.js';
import { createIronProxy, isStrictlyInside, type IronProxy } from '../src/manager.js';
import type { Profile } from '../src/types.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli/fake-cli.mjs', import.meta.url));

let dir: string;
let data: string;
let user: string;
let iron: IronProxy | undefined;

/** The real default registry, with every vendor CLI lane pointed at the fake CLI. */
function fakeRegistry() {
  return createDefaultRegistry()
    .addLane('anthropic', new CliLane({ ...claudeSpec, binary: FAKE }))
    .addLane('openai', new CliLane({ ...codexSpec, binary: FAKE }))
    .addLane('xai', new CliLane({ ...grokSpec, binary: FAKE }))
    .addLane('google', new CliLane({ ...geminiSpec, binary: FAKE }));
}

/** Env where the vendor CLIs' default homes live inside the temp dir, never the real ~. */
function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { HOME: user, USERPROFILE: user, ...extra };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-adopt-'));
  data = join(dir, 'data');
  user = join(dir, 'user');
  await mkdir(user, { recursive: true });
});
afterEach(async () => {
  await iron?.close();
  iron = undefined;
  // A background status check may still hold a home open on Windows for a moment.
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/**
 * createProfile, then wait for the background status check it starts, so no
 * fake CLI process still holds the home open when the test deletes it.
 */
async function createSettled(input: Parameters<IronProxy['createProfile']>[0]): Promise<Profile> {
  const seen = new Set<string>();
  let wake: () => void = () => {};
  const off = iron!.events.on('profile.state', (e) => {
    seen.add(e.state.profileId);
    wake();
  });
  try {
    const p = await iron!.createProfile(input);
    while (!seen.has(p.id)) await new Promise<void>((r) => (wake = r));
    return p;
  } finally {
    off();
  }
}

describe('discoverLogins', () => {
  it('finds signed-in and signed-out default homes, and skips missing ones and Gemini', async () => {
    const claudeHome = join(dir, 'claude-config');
    const codexHome = join(user, '.codex');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(join(claudeHome, 'logged-in'), 'yes'); // the fake CLI's "signed in" marker
    await mkdir(codexHome, { recursive: true }); // present but signed out
    await mkdir(join(user, '.gemini'), { recursive: true }); // never offered
    iron = createIronProxy({
      dataDir: data,
      registry: fakeRegistry(),
      env: fakeEnv({ CLAUDE_CONFIG_DIR: claudeHome }),
    });

    const found = await iron.discoverLogins();
    expect(found.map((f) => f.provider).sort()).toEqual(['anthropic', 'openai']);
    const claude = found.find((f) => f.provider === 'anthropic')!;
    expect(claude).toEqual({
      provider: 'anthropic',
      binary: FAKE, // the spec's binary: here the fake stands in for `claude`
      home: resolve(claudeHome),
      installed: true,
      status: 'ok',
      suggestedTitle: 'Claude (existing login)',
    });
    const codex = found.find((f) => f.provider === 'openai')!;
    expect(codex.status).toBe('unauthenticated');
    expect(codex.home).toBe(resolve(codexHome));
    expect(codex.suggestedTitle).toBe('Codex (existing login)');
    // Nothing was persisted.
    expect(await iron.listProfiles()).toEqual([]);
    expect(JSON.stringify(found)).not.toMatch(/@/);
  });

  it('reports a missing binary as not installed without running anything', async () => {
    const claudeHome = join(user, '.claude');
    await mkdir(claudeHome, { recursive: true });
    const registry = createDefaultRegistry().addLane(
      'anthropic',
      new CliLane({ ...claudeSpec, binary: 'definitely-not-a-real-binary-xyz' }),
    );
    // Other lanes keep their real binaries but have no default home under the fake user.
    iron = createIronProxy({ dataDir: data, registry, env: fakeEnv() });
    const [claude] = await iron.discoverLogins();
    expect(claude).toMatchObject({ provider: 'anthropic', installed: false, status: 'unknown' });
    expect(await readdir(claudeHome)).toEqual([]);
  });

  it('marks an adopted home and de-duplicates the suggested title', async () => {
    const claudeHome = join(user, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(join(claudeHome, 'logged-in'), 'yes');
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });
    await iron.createProfile({
      title: 'Claude (existing login)',
      provider: 'anthropic',
      lane: 'api-key',
    });
    const before = (await iron.discoverLogins())[0]!;
    expect(before.adoptedProfileId).toBeUndefined();
    expect(before.suggestedTitle).toBe('Claude (existing login) 2');

    const adopted = await iron.adoptLogin({ provider: 'anthropic', home: before.home });
    expect(adopted.title).toBe('Claude (existing login) 2');
    const after = (await iron.discoverLogins())[0]!;
    expect(after.adoptedProfileId).toBe(adopted.id);
    // A differently-spelled path to the same directory still counts as adopted.
    const spelled =
      process.platform === 'win32' ? claudeHome.toUpperCase() + '\\.' : claudeHome + '/.';
    await expect(iron.adoptLogin({ provider: 'anthropic', home: spelled })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('adoptLogin', () => {
  it('uses the home in place, marks it adopted, checks status, and answers through it', async () => {
    const home = join(user, '.claude');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'logged-in'), 'yes');
    await writeFile(join(home, 'settings.json'), '{"user":"own"}');
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });

    const p = await iron.adoptLogin({ provider: 'anthropic', home, title: 'My Claude' });
    expect(p).toMatchObject({
      title: 'My Claude',
      provider: 'anthropic',
      lane: 'cli',
      cli: { home: resolve(home), adopted: true },
    });
    expect((await iron.allStates())[p.id]?.status).toBe('ready');
    const res = await iron.complete({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    });
    expect(res.profileId).toBe(p.id);
    expect(res.message.content[0]).toEqual({ type: 'text', text: 'echo:ping' });
    const inv = JSON.parse(await readFile(join(home, 'last-invocation.json'), 'utf8')) as {
      env: Record<string, string>;
    };
    expect(inv.env.CLAUDE_CONFIG_DIR).toBe(resolve(home));
  });

  it('refuses a missing directory, a duplicate home and an unknown provider', async () => {
    const home = join(user, '.codex');
    await mkdir(home, { recursive: true });
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });

    const missing = await iron
      .adoptLogin({ provider: 'openai', home: join(user, 'nope') })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(IronProxyError);
    expect((missing as IronProxyError).code).toBe('INVALID_REQUEST');
    expect((missing as IronProxyError).hint).toMatch(/Sign in with Codex CLI itself first/);

    const first = await iron.adoptLogin({ provider: 'openai', home });
    expect(first.title).toBe('Codex (existing login)');
    const dup = await iron.adoptLogin({ provider: 'openai', home }).catch((e: unknown) => e);
    expect((dup as IronProxyError).code).toBe('INVALID_REQUEST');
    expect((dup as IronProxyError).message).toContain('already uses');
    expect((dup as IronProxyError).hint).toContain(first.id);

    await expect(iron.adoptLogin({ provider: 'nope' as 'openai', home })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect((await iron.listProfiles()).length).toBe(1);
  });

  it('deleting an adopted profile leaves the directory and its files intact', async () => {
    const home = join(user, '.grok');
    await mkdir(join(home, 'nested'), { recursive: true });
    await writeFile(join(home, 'logged-in'), 'yes');
    await writeFile(join(home, 'nested', 'keep.txt'), 'mine');
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });
    const p = await iron.adoptLogin({ provider: 'xai', home });
    await iron.deleteProfile(p.id);
    expect(await iron.listProfiles()).toEqual([]);
    expect((await stat(home)).isDirectory()).toBe(true);
    expect(await readFile(join(home, 'nested', 'keep.txt'), 'utf8')).toBe('mine');
    expect(await readFile(join(home, 'logged-in'), 'utf8')).toBe('yes');
  });

  it('never deletes an adopted home even when it sits under <dataDir>/cli-homes', async () => {
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });
    const home = join(data, 'cli-homes', 'anthropic', 'left-over');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'keep.txt'), 'mine');
    const p = await iron.adoptLogin({ provider: 'anthropic', home });
    await iron.deleteProfile(p.id);
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('never prepares or creates an adopted home (discovery and adoption touch nothing)', async () => {
    const prepared: string[] = [];
    const lane = new CliLane({
      ...claudeSpec,
      binary: FAKE,
      prepareHome: async (h) => void prepared.push(h),
    });
    const home = join(user, '.claude');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'logged-in'), 'yes');
    iron = createIronProxy({
      dataDir: data,
      registry: createDefaultRegistry().addLane('anthropic', lane),
      env: fakeEnv(),
    });
    await iron.discoverLogins();
    const p = await iron.adoptLogin({ provider: 'anthropic', home });
    await iron.refreshStatus(p.id);
    expect(prepared).toEqual([]);
    // An adopted home that vanished is not recreated.
    const gone = join(dir, 'gone');
    await lane.ensureHome({ ...p, cli: { home: gone, adopted: true } });
    await expect(stat(gone)).rejects.toThrow();
    // A home Iron-Proxy owns is still prepared.
    await lane.ensureHome({ ...p, cli: { home: join(dir, 'own') } });
    expect(prepared).toEqual([join(dir, 'own')]);
  });

  it('is on the client surface every transport maps', async () => {
    const home = join(user, '.claude');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'logged-in'), 'yes');
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });
    expect(IRON_CLIENT_METHODS).toContain('discoverLogins');
    expect(IRON_CLIENT_METHODS).toContain('adoptLogin');
    const client = new LocalIronClient(iron);
    const [found] = await client.discoverLogins();
    const p = await client.adoptLogin({ provider: found!.provider, home: found!.home });
    expect(p.cli?.adopted).toBe(true);
  });
});

describe('an adopted home stays safe from patches and deletes', () => {
  it('a patch cannot clear cli.adopted or move an adopted home, so deleting leaves the directory', async () => {
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });
    // The worst case: an adopted login that sits where Iron-Proxy's own homes live.
    const home = join(data, 'cli-homes', 'anthropic', 'adopted-here');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'keep.txt'), 'mine');
    const p = await iron.adoptLogin({ provider: 'anthropic', home });

    // What a PATCH /iron/profiles/:id body could carry.
    const patched = await iron.updateProfile(p.id, { cli: { home, adopted: false } });
    expect(patched.cli).toMatchObject({ home: resolve(home), adopted: true });
    const moved = await iron.updateProfile(p.id, {
      cli: { home: join(data, 'cli-homes', 'anthropic', 'other'), adopted: true },
    });
    expect(moved.cli?.home).toBe(resolve(home));
    expect((await iron.getProfile(p.id)).cli).toMatchObject({ home: resolve(home), adopted: true });

    await iron.deleteProfile(p.id);
    expect(await iron.listProfiles()).toEqual([]);
    expect(await readFile(join(home, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('a patch still moves the home of a profile Iron-Proxy owns, and never marks it adopted', async () => {
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });
    const p = await createSettled({ title: 'Own', provider: 'anthropic', lane: 'cli' });
    const next = join(dir, 'moved-home');
    const patched = await iron.updateProfile(p.id, { cli: { home: next, adopted: true } });
    expect(patched.cli?.home).toBe(next);
    expect(patched.cli?.adopted).toBeUndefined();
  });

  it('deleteProfile removes only a home strictly inside <dataDir>/cli-homes', async () => {
    iron = createIronProxy({ dataDir: data, registry: fakeRegistry(), env: fakeEnv() });
    const make = async (title: string, home: string) => {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, 'keep.txt'), 'mine');
      return createSettled({ title, provider: 'anthropic', lane: 'cli', cli: { home } });
    };
    // A sibling that merely shares the prefix, and cli-homes itself: never deleted.
    const sibling = join(data, 'cli-homes-evil', 'x');
    const root = join(data, 'cli-homes');
    const s = await make('Sibling', sibling);
    const r = await make('Root', root);
    await iron.deleteProfile(s.id);
    await iron.deleteProfile(r.id);
    expect(await readFile(join(sibling, 'keep.txt'), 'utf8')).toBe('mine');
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('mine');

    // A home Iron-Proxy created inside cli-homes still goes (the control).
    const own = await createSettled({ title: 'Own', provider: 'anthropic', lane: 'cli' });
    expect((await stat(own.cli!.home)).isDirectory()).toBe(true);
    await iron.deleteProfile(own.id);
    await expect(stat(own.cli!.home)).rejects.toThrow();
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('isStrictlyInside rejects the folder itself, prefix siblings, parents and escapes', () => {
    const base = join(dir, 'cli-homes');
    expect(isStrictlyInside(base, join(base, 'anthropic', 'p1'))).toBe(true);
    expect(isStrictlyInside(base, base)).toBe(false);
    expect(isStrictlyInside(base, join(base, '.'))).toBe(false);
    expect(isStrictlyInside(base, `${base}-evil`)).toBe(false);
    expect(isStrictlyInside(base, join(`${base}-evil`, 'x'))).toBe(false);
    expect(isStrictlyInside(base, join(base, '..', 'elsewhere'))).toBe(false);
    // A child whose name merely begins with '..' is inside; only a parent step escapes.
    expect(isStrictlyInside(base, join(base, '..cache'))).toBe(true);
    expect(isStrictlyInside(base, join(base, '..cache', 'p1'))).toBe(true);
    expect(isStrictlyInside(base, join(base, '..'))).toBe(false);
    expect(isStrictlyInside(base, dir)).toBe(false);
    expect(isStrictlyInside(base, join(tmpdir(), 'unrelated'))).toBe(false);
    // Case-folded on Windows, exact elsewhere.
    const upper = join(base.toUpperCase(), 'x');
    if (process.platform === 'win32') expect(isStrictlyInside(base, upper, 'win32')).toBe(true);
    else if (upper !== join(base, 'x')) expect(isStrictlyInside(base, upper, 'linux')).toBe(false);
  });
});

describe('discoverLogins runs the status probes in parallel', () => {
  it('starts every probe before any finishes, and keeps registry order in the result', async () => {
    const homes = {
      anthropic: join(user, '.claude'),
      openai: join(user, '.codex'),
      xai: join(user, '.grok'),
    };
    for (const h of Object.values(homes)) {
      await mkdir(h, { recursive: true });
      await writeFile(join(h, 'logged-in'), 'yes');
    }
    let started = 0;
    let release!: () => void;
    const allStarted = new Promise<void>((r) => (release = r));
    const finished: string[] = [];
    /** A real CliLane whose status check waits until all three probes are running. */
    class GatedLane extends CliLane {
      constructor(
        spec: ConstructorParameters<typeof CliLane>[0],
        private readonly delayMs: number,
      ) {
        super(spec);
      }
      override async checkAuth(profile: Profile) {
        if (++started === 3) release();
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probes ran one after another')), 3000),
        );
        await Promise.race([allStarted, timeout]);
        await new Promise((r) => setTimeout(r, this.delayMs));
        const status = await super.checkAuth(profile);
        finished.push(profile.provider);
        return status;
      }
    }
    iron = createIronProxy({
      dataDir: data,
      // The first in registry order finishes last.
      registry: createDefaultRegistry()
        .addLane('anthropic', new GatedLane({ ...claudeSpec, binary: FAKE }, 300))
        .addLane('openai', new GatedLane({ ...codexSpec, binary: FAKE }, 150))
        .addLane('xai', new GatedLane({ ...grokSpec, binary: FAKE }, 0)),
      env: fakeEnv(),
    });
    const found = await iron.discoverLogins();
    expect(found.map((f) => [f.provider, f.status])).toEqual([
      ['anthropic', 'ok'],
      ['openai', 'ok'],
      ['xai', 'ok'],
    ]);
    expect(finished[finished.length - 1]).toBe('anthropic');
    expect(found.map((f) => f.suggestedTitle)).toEqual([
      'Claude (existing login)',
      'Codex (existing login)',
      'Grok (existing login)',
    ]);
  });
});
