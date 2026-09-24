import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import type {
  AdoptLoginInput,
  CliProbe,
  DiscoveredLogin,
  FailoverPolicy,
  IronEvent,
  LaneKind,
  LoginSession,
  Profile,
  ProfileInput,
  ProfilePatch,
  ProfileState,
  ProviderId,
  RunOptions,
  StreamEvent,
  UnifiedRequest,
  UnifiedResponse,
  UsageReport,
} from './types.js';
import { PROVIDER_IDS } from './types.js';
import {
  AllProfilesExhaustedError,
  AuthRequiredError,
  IronProxyError,
  NoProfileError,
  ProfileNotFoundError,
} from './errors.js';
import { TypedEmitter, type IronEmitter } from './events.js';
import { createDefaultRegistry } from './adapters/index.js';
import type { AdapterRegistry, FetchLike } from './adapters/types.js';
import { CliLane } from './adapters/cli/lane.js';
import { CLI_SPECS } from './adapters/cli/specs.js';
import { run, which } from './adapters/cli/runner.js';
import { Router } from './router/router.js';
import { FileProfileStore, type ProfileStore } from './store/profile-store.js';
import { FileStateStore, type StateStore } from './store/state-store.js';
import { FileUsageStore, type UsageStore } from './store/usage-store.js';
import { buildUsageReport } from './usage/report.js';
import { FileVault, type KeyProtector, type Vault } from './vault/vault.js';
import { isoNow, newId, systemClock, type Clock } from './util.js';

export interface IronProxyOptions {
  /** Where profiles, state, the vault and isolated CLI homes live. Default `~/.iron-proxy`. */
  dataDir?: string;
  profiles?: ProfileStore;
  states?: StateStore;
  /**
   * Usage history (finished requests, parks, utilisation samples) behind
   * `usageReport()`. Default `<dataDir>/usage.json`, bounded to 14 days.
   */
  usage?: UsageStore;
  vault?: Vault;
  /** Used only when `vault` is not given, to protect the file vault's key. */
  keyProtector?: KeyProtector;
  registry?: AdapterRegistry;
  policy?: Partial<FailoverPolicy>;
  clock?: Clock;
  fetch?: FetchLike;
  /**
   * Environment used to find the vendor CLIs' default homes when discovering
   * existing logins (CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME, HOME/USERPROFILE).
   * Default `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

/** Short provider names used in suggested account titles, e.g. "Claude (existing login)". */
export const PROVIDER_SHORT_NAMES: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Claude',
  openai: 'Codex',
  google: 'Gemini',
  xai: 'Grok',
  'openai-compatible': 'Custom',
};

/** Same directory? Resolved, and case-insensitive on Windows. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * True only when `child` is a path strictly below `parent`: not `parent` itself,
 * not a sibling that merely shares its prefix (`cli-homes-evil`), not outside it.
 * Case-insensitive on Windows. Exported for tests.
 */
export function isStrictlyInside(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fold = (p: string) => (platform === 'win32' ? p.toLowerCase() : p);
  const rel = relative(fold(resolve(parent)), fold(resolve(child)));
  // Only a real parent step escapes: a child named '..cache' is still inside.
  const escapes =
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith('../') ||
    (platform === 'win32' && rel.startsWith('..\\'));
  return rel !== '' && !escapes && !isAbsolute(rel);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function defaultDataDir(): string {
  return process.env.IRON_PROXY_DATA_DIR ?? join(homedir(), '.iron-proxy');
}

/**
 * The facade a host application talks to. Owns the stores, the vault, the
 * adapter registry, the router and the event stream.
 */
export class IronProxy {
  readonly dataDir: string;
  readonly profiles: ProfileStore;
  readonly states: StateStore;
  readonly usage: UsageStore;
  readonly vault: Vault;
  readonly registry: AdapterRegistry;
  readonly events: IronEmitter;
  readonly router: Router;
  private readonly clock: Clock;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logins = new Map<string, LoginSession>();
  /** Usage-history writes in flight, awaited by close() before the flush. */
  private readonly usageWrites = new Set<Promise<void>>();
  private readonly usageOff: Array<() => void> = [];

  constructor(opts: IronProxyOptions = {}) {
    this.dataDir = opts.dataDir ?? defaultDataDir();
    this.profiles = opts.profiles ?? new FileProfileStore(this.dataDir);
    this.states = opts.states ?? new FileStateStore(this.dataDir);
    this.vault = opts.vault ?? new FileVault(this.dataDir, opts.keyProtector);
    this.registry = opts.registry ?? createDefaultRegistry();
    this.events = new TypedEmitter<IronEvent>();
    this.clock = opts.clock ?? systemClock;
    this.env = opts.env ?? process.env;
    this.router = new Router({
      profiles: this.profiles,
      states: this.states,
      vault: this.vault,
      registry: this.registry,
      emitter: this.events,
      clock: this.clock,
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    this.usage = opts.usage ?? new FileUsageStore(this.dataDir, { clock: this.clock });
    this.recordUsageHistory();
  }

  /**
   * Feed the usage history from the manager's own events and the router's usage
   * hook. Only counts, kinds and timestamps are kept: no prompt text, output,
   * secrets or emails.
   */
  private recordUsageHistory(): void {
    const track = (write: () => Promise<void>) => {
      const p = write().catch(() => {});
      this.usageWrites.add(p);
      void p.then(() => this.usageWrites.delete(p));
    };
    const at = () => isoNow(this.clock);
    this.usageOff.push(
      this.events.on('request.finished', (e) =>
        track(() =>
          this.usage.addRequest(e.profileId, {
            at: at(),
            durationMs: e.durationMs,
            ...(e.usage?.inputTokens !== undefined ? { inputTokens: e.usage.inputTokens } : {}),
            ...(e.usage?.outputTokens !== undefined ? { outputTokens: e.usage.outputTokens } : {}),
            ...(e.usage?.cacheReadTokens !== undefined
              ? { cacheReadTokens: e.usage.cacheReadTokens }
              : {}),
          }),
        ),
      ),
      this.events.on('profile.parked', (e) =>
        track(() =>
          this.usage.addPark(e.profileId, {
            at: at(),
            kind: e.reason.kind,
            ...(e.until ? { until: e.until } : {}),
          }),
        ),
      ),
      this.router.onUsage((profileId, usage) => {
        const u = usage.utilisation;
        if (typeof u !== 'number' || !Number.isFinite(u)) return;
        track(() =>
          this.usage.addSample(profileId, {
            at: at(),
            utilisation: u,
            ...(usage.resetAt ? { resetAt: usage.resetAt } : {}),
          }),
        );
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Profiles                                                         */
  /* ---------------------------------------------------------------- */

  async listProfiles(provider?: ProviderId): Promise<Profile[]> {
    const all = await this.profiles.list();
    return (provider ? all.filter((p) => p.provider === provider) : all).sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.order - b.order,
    );
  }

  async getProfile(id: string): Promise<Profile> {
    const p = await this.profiles.get(id);
    if (!p) throw new ProfileNotFoundError(id);
    return p;
  }

  /**
   * Create a profile. For the CLI lane an isolated home directory is created
   * under `<dataDir>/cli-homes/<provider>/<id>` unless one is supplied.
   */
  createProfile(input: ProfileInput & { apiKeySecret?: string }): Promise<Profile> {
    return this.insertProfile(input, true);
  }

  private async insertProfile(
    input: ProfileInput & { apiKeySecret?: string },
    refresh: boolean,
  ): Promise<Profile> {
    if (!PROVIDER_IDS.includes(input.provider)) {
      throw new IronProxyError('INVALID_REQUEST', `Unknown provider "${input.provider}".`, {
        hint: `Use one of: ${PROVIDER_IDS.join(', ')}.`,
      });
    }
    if (!input.title?.trim())
      throw new IronProxyError('INVALID_REQUEST', 'A profile needs a title.', {
        hint: 'Give the account a title you will recognise, e.g. "Work Claude".',
      });
    if (input.lane === 'oauth' && !input.oauth?.extension) {
      throw new IronProxyError(
        'INVALID_REQUEST',
        'An oauth profile needs oauth.extension (the registered extension name).',
      );
    }
    const adapter = this.registry.get(input.provider);
    if (!adapter.lanes[input.lane]) {
      throw new IronProxyError(
        'UNSUPPORTED',
        `Provider "${input.provider}" has no "${input.lane}" lane. Register one with registry.addLane().`,
      );
    }
    const id = newId('prof');
    const siblings = await this.listProfiles(input.provider);
    const order =
      input.order ?? (siblings.length ? Math.max(...siblings.map((s) => s.order)) + 1 : 0);
    const now = isoNow(this.clock);
    const profile: Profile = {
      id,
      title: input.title.trim(),
      provider: input.provider,
      lane: input.lane,
      order,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    if (input.defaultModel) profile.defaultModel = input.defaultModel;
    if (input.lane === 'cli') {
      profile.cli = {
        home: join(this.dataDir, 'cli-homes', input.provider, id),
        ...(input.cli ?? {}),
      };
      const lane = this.registry.laneFor(profile);
      if (lane instanceof CliLane) await lane.ensureHome(profile);
    } else if (input.lane === 'api-key') {
      const secretRef = input.apiKey?.secretRef || `apikey:${id}`; // an empty ref means "assign one"
      profile.apiKey = { ...(input.apiKey ?? {}), secretRef };
      if (input.provider === 'openai-compatible' && !profile.apiKey.baseUrl) {
        throw new IronProxyError(
          'INVALID_REQUEST',
          'An openai-compatible profile needs apiKey.baseUrl.',
          { hint: "Pass the server's /v1 URL, e.g. --base-url http://127.0.0.1:11434/v1." },
        );
      }
      if (input.apiKeySecret) await this.vault.set(secretRef, input.apiKeySecret);
    } else if (input.lane === 'oauth') {
      if (!input.oauth?.extension)
        throw new IronProxyError('INVALID_REQUEST', 'An oauth profile needs oauth.extension.');
      profile.oauth = {
        secretRef: input.oauth.secretRef ?? `oauth:${id}`,
        extension: input.oauth.extension,
      };
    }
    await this.profiles.put(profile);
    await this.states.put({ profileId: id, status: 'unknown', served: 0 });
    this.events.emit({ type: 'profile.created', profile });
    if (refresh) void this.refreshStatus(id).catch(() => {});
    return profile;
  }

  async updateProfile(id: string, patch: ProfilePatch): Promise<Profile> {
    const p = await this.getProfile(id);
    if (patch.title !== undefined) {
      if (!patch.title.trim())
        throw new IronProxyError('INVALID_REQUEST', 'A profile needs a title.');
      p.title = patch.title.trim();
    }
    if (patch.order !== undefined) p.order = patch.order;
    if (patch.enabled !== undefined) p.enabled = patch.enabled;
    if (patch.defaultModel !== undefined) {
      if (patch.defaultModel) p.defaultModel = patch.defaultModel;
      else delete p.defaultModel;
    }
    if (patch.cli && p.cli) {
      // `adopted` is set only by adoptLogin and never by a patch: clearing it would let
      // deleteProfile remove a login the user made. An adopted profile keeps its home.
      const { adopted: _adopted, home, ...rest } = patch.cli;
      const newHome = home !== undefined && !p.cli.adopted ? home : undefined;
      if (newHome !== undefined) {
        const owner = (await this.profiles.list()).find(
          (o) => o.id !== id && !!o.cli?.home && samePath(o.cli.home, newHome),
        );
        if (owner)
          throw new IronProxyError(
            'INVALID_REQUEST',
            `Profile "${owner.title}" already uses "${resolve(newHome)}".`,
            {
              details: { home: resolve(newHome), profileId: owner.id },
              hint: `Pick another directory; two profiles on one home would fail over onto the same account (${owner.id} uses it).`,
            },
          );
      }
      p.cli = { ...p.cli, ...rest, ...(newHome !== undefined ? { home: newHome } : {}) };
    }
    if (patch.apiKey && p.apiKey) p.apiKey = { ...p.apiKey, ...patch.apiKey };
    if (patch.oauth && p.oauth) p.oauth = { ...p.oauth, ...patch.oauth };
    p.updatedAt = isoNow(this.clock);
    await this.profiles.put(p);
    this.events.emit({ type: 'profile.updated', profile: p });
    if (patch.enabled !== undefined) {
      const st = await this.router.state(id);
      st.status = patch.enabled ? 'unknown' : 'disabled';
      await this.states.put(st);
      this.events.emit({ type: 'profile.state', state: st });
      if (patch.enabled) void this.refreshStatus(id).catch(() => {});
    }
    return p;
  }

  /**
   * Delete the profile, its secrets and (for CLI profiles) its isolated home
   * directory. Only directories Iron-Proxy created under `<dataDir>/cli-homes`
   * are removed; an adopted home is never touched, and neither is a home that
   * another profile also uses or that holds another profile's home.
   */
  async deleteProfile(id: string, opts: { keepFiles?: boolean } = {}): Promise<void> {
    const p = await this.getProfile(id);
    this.logins.get(id)?.cancel();
    if (p.apiKey?.secretRef) await this.vault.delete(p.apiKey.secretRef).catch(() => {});
    if (p.oauth?.secretRef) await this.vault.delete(p.oauth.secretRef).catch(() => {});
    const home = p.cli?.home;
    if (
      home &&
      !p.cli?.adopted &&
      !opts.keepFiles &&
      isStrictlyInside(join(this.dataDir, 'cli-homes'), home)
    ) {
      const shared = (await this.profiles.list()).some(
        (o) =>
          o.id !== id &&
          !!o.cli?.home &&
          (samePath(o.cli.home, home) || isStrictlyInside(home, o.cli.home)),
      );
      if (!shared) await rm(home, { recursive: true, force: true }).catch(() => {});
    }
    await this.profiles.delete(id);
    await this.states.delete(id);
    await this.usage.delete(id).catch(() => {});
    this.events.emit({ type: 'profile.deleted', profileId: id });
  }

  /** Reorder a provider's profiles. `ids` is the full new order; missing ones keep relative position after. */
  async reorder(provider: ProviderId, ids: string[]): Promise<Profile[]> {
    const current = await this.listProfiles(provider);
    const byId = new Map(current.map((p) => [p.id, p]));
    const ordered = [
      ...ids.map((id) => byId.get(id)).filter((p): p is Profile => !!p),
      ...current.filter((p) => !ids.includes(p.id)),
    ];
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i]!;
      if (p.order !== i) {
        p.order = i;
        p.updatedAt = isoNow(this.clock);
        await this.profiles.put(p);
        this.events.emit({ type: 'profile.updated', profile: p });
      }
    }
    return ordered;
  }

  /** Make this profile the primary for its provider (order 0) and clear any park on it. */
  async activate(id: string): Promise<Profile> {
    const p = await this.getProfile(id);
    const rest = (await this.listProfiles(p.provider)).filter((x) => x.id !== id).map((x) => x.id);
    await this.reorder(p.provider, [id, ...rest]);
    await this.router.unpark(id);
    return this.getProfile(id);
  }

  async setApiKey(id: string, secret: string): Promise<void> {
    const p = await this.getProfile(id);
    if (p.lane !== 'api-key' || !p.apiKey)
      throw new IronProxyError('INVALID_REQUEST', 'Profile is not an API-key profile.', {
        hint: 'Only API-key accounts take a key; log subscription accounts in with iron-proxy login <id>.',
      });
    await this.vault.set(p.apiKey.secretRef, secret);
    const st = await this.router.state(id);
    st.status = 'ready';
    delete st.lastError;
    await this.states.put(st);
    this.events.emit({ type: 'profile.state', state: st });
  }

  /* ---------------------------------------------------------------- */
  /* Existing logins                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Vendor CLIs already signed in at their default home on this machine. Runs
   * each CLI's own status command against that home; never reads credential
   * files, never persists anything and never reports an email.
   */
  async discoverLogins(): Promise<DiscoveredLogin[]> {
    const profiles = await this.profiles.list();
    // Each vendor's status command runs at the same time; results keep registry order.
    const probed = await Promise.all(
      this.registry.list().map(async (adapter) => {
        const lane = adapter.lanes.cli;
        if (!(lane instanceof CliLane)) return undefined;
        const found = lane.spec.defaultHome?.(this.env);
        if (!found) return undefined;
        const home = resolve(found);
        if (!(await isDirectory(home))) return undefined;
        // A throwaway profile, never stored: `adopted` keeps ensureHome from touching the directory.
        const probe: Profile = {
          id: `discover-${adapter.id}`,
          title: lane.spec.displayName,
          provider: adapter.id,
          lane: 'cli',
          order: 0,
          enabled: true,
          cli: { home, adopted: true },
          createdAt: '',
          updatedAt: '',
        };
        const installed = !!(await lane.findBinary(probe));
        const status = installed
          ? await lane.checkAuth(probe).catch(() => 'unknown' as const)
          : 'unknown';
        return { provider: adapter.id, binary: lane.spec.binary, home, installed, status };
      }),
    );
    const taken = new Set(profiles.map((p) => p.title));
    const out: DiscoveredLogin[] = [];
    for (const f of probed) {
      if (!f) continue;
      const owner = profiles.find((p) => !!p.cli?.home && samePath(p.cli.home, f.home));
      const suggestedTitle = freeTitle(
        `${PROVIDER_SHORT_NAMES[f.provider]} (existing login)`,
        taken,
      );
      taken.add(suggestedTitle);
      out.push({ ...f, ...(owner ? { adoptedProfileId: owner.id } : {}), suggestedTitle });
    }
    return out;
  }

  /**
   * The default home a provider's vendor CLI uses on this machine (resolved, not
   * checked for existence), without running anything. Undefined when the
   * provider has no vendor CLI or the CLI has no default home.
   */
  defaultCliHome(provider: ProviderId): string | undefined {
    if (!PROVIDER_IDS.includes(provider)) return undefined;
    const lane = this.registry.get(provider).lanes.cli;
    if (!(lane instanceof CliLane)) return undefined;
    const found = lane.spec.defaultHome?.(this.env);
    return found ? resolve(found) : undefined;
  }

  /**
   * Turn an existing CLI login into a profile, as-is: the profile's home is that
   * directory, nothing is copied, and deleting the profile never removes it.
   */
  async adoptLogin(input: AdoptLoginInput): Promise<Profile> {
    if (!input || !PROVIDER_IDS.includes(input.provider))
      throw new IronProxyError('INVALID_REQUEST', `Unknown provider "${input?.provider}".`, {
        hint: `Use one of: ${PROVIDER_IDS.join(', ')}.`,
      });
    const lane = this.registry.get(input.provider).lanes.cli;
    if (!(lane instanceof CliLane))
      throw new IronProxyError(
        'UNSUPPORTED',
        `Provider "${input.provider}" has no vendor CLI to adopt a login from.`,
        { hint: 'Adopt a Claude, Codex or Grok login, or add this provider with an API key.' },
      );
    if (typeof input.home !== 'string' || !input.home.trim())
      throw new IronProxyError('INVALID_REQUEST', 'Adopting a login needs its home directory.', {
        hint: 'Run iron-proxy profiles discover to see the logins found on this computer.',
      });
    const home = resolve(input.home.trim());
    if (!(await isDirectory(home)))
      throw new IronProxyError('INVALID_REQUEST', `No CLI home directory at "${home}".`, {
        details: { home },
        hint: `Sign in with ${lane.spec.displayName} itself first, or pass the directory it uses with --home.`,
      });
    const existing = await this.profiles.list();
    const owner = existing.find((p) => !!p.cli?.home && samePath(p.cli.home, home));
    if (owner)
      throw new IronProxyError(
        'INVALID_REQUEST',
        `Profile "${owner.title}" already uses "${home}".`,
        {
          details: { home, profileId: owner.id },
          hint: `Use the existing profile ${owner.id}; two profiles on one login would fail over onto the same account.`,
        },
      );
    const title =
      input.title?.trim() ||
      freeTitle(
        `${PROVIDER_SHORT_NAMES[input.provider]} (existing login)`,
        new Set(existing.map((p) => p.title)),
      );
    const profile = await this.insertProfile(
      { title, provider: input.provider, lane: 'cli', cli: { home, adopted: true } },
      false,
    );
    await this.refreshStatus(profile.id).catch(() => []);
    return profile;
  }

  /* ---------------------------------------------------------------- */
  /* Auth                                                             */
  /* ---------------------------------------------------------------- */

  /** Start a login. Progress arrives as `login` events and on the returned session. */
  login(id: string, opts: { headless?: boolean } = {}): Promise<LoginSession> {
    return (async () => {
      const p = await this.getProfile(id);
      const lane = this.registry.laneFor(p);
      if (!lane.login)
        throw new IronProxyError(
          'UNSUPPORTED',
          `The ${p.lane} lane for ${p.provider} has no interactive login. Set an API key instead.`,
        );
      this.logins.get(id)?.cancel();
      const session = (lane as CliLane).login(p, this.vault, opts);
      this.logins.set(id, session);
      session.on((event) => this.events.emit({ type: 'login', event }));
      session.done
        .then(async () => {
          const st = await this.router.state(id);
          st.status = 'ready';
          delete st.lastError;
          delete st.parkedReason;
          await this.states.put(st);
          this.events.emit({ type: 'profile.state', state: st });
        })
        .catch(() => {})
        .finally(() => {
          if (this.logins.get(id) === session) this.logins.delete(id);
        });
      return session;
    })();
  }

  /** The terminal command a host can run itself when headless login is not possible. */
  async loginCommand(id: string): Promise<{
    binary: string;
    args: string[];
    env: Record<string, string>;
    requiresTerminal: boolean;
  }> {
    const p = await this.getProfile(id);
    const lane = this.registry.laneFor(p);
    if (!(lane instanceof CliLane))
      throw new IronProxyError('UNSUPPORTED', 'Only CLI profiles have a login command.');
    const cmd = lane.loginCommand(p, false);
    return { ...cmd, requiresTerminal: lane.spec.login.requiresTerminal ?? false };
  }

  async logout(id: string): Promise<void> {
    const p = await this.getProfile(id);
    this.logins.get(id)?.cancel();
    const lane = this.registry.laneFor(p);
    await lane.logout?.(p, this.vault);
    const st = await this.router.state(id);
    st.status = 'unauthenticated';
    await this.states.put(st);
    this.events.emit({ type: 'profile.state', state: st });
  }

  /** Re-check authentication for one or all profiles. */
  async refreshStatus(id?: string): Promise<ProfileState[]> {
    const targets = id ? [await this.getProfile(id)] : await this.listProfiles();
    const out: ProfileState[] = [];
    await Promise.all(
      targets.map(async (p) => {
        const st = await this.router.state(p.id);
        if (!p.enabled) {
          st.status = 'disabled';
        } else if (st.status !== 'parked' && st.status !== 'active') {
          const lane = this.registry.laneFor(p);
          const result = await lane.checkAuth(p, this.vault).catch(() => 'unknown' as const);
          st.status =
            result === 'unauthenticated'
              ? 'unauthenticated'
              : result === 'ok'
                ? 'ready'
                : st.status === 'unknown'
                  ? 'ready'
                  : st.status;
        }
        await this.states.put(st);
        this.events.emit({ type: 'profile.state', state: st });
        out.push(st);
      }),
    );
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* Running requests                                                 */
  /* ---------------------------------------------------------------- */

  complete(req: UnifiedRequest, opts?: RunOptions): Promise<UnifiedResponse> {
    return this.router.complete(req, opts);
  }

  stream(req: UnifiedRequest, opts?: RunOptions): AsyncGenerator<StreamEvent> {
    return this.router.stream(req, opts);
  }

  /* ---------------------------------------------------------------- */
  /* Picking an account for the user's own terminal                   */
  /* ---------------------------------------------------------------- */

  /**
   * The account a request for `provider` would try first right now: enabled,
   * on `lane` (default `cli`; `any` for every lane), not parked (a park whose
   * cooldown has passed is cleared, exactly as the router does), not signed out,
   * lowest order. With `profileId`, that profile, if it is an enabled account of
   * that provider on that lane.
   *
   * Throws NoProfileError when there is no such account, AllProfilesExhaustedError
   * (with the earliest reset) when the rest are parked, and AuthRequiredError when
   * every one needs to sign in again.
   */
  async pickProfile(
    provider: ProviderId,
    opts: { profileId?: string; lane?: LaneKind | 'any' } = {},
  ): Promise<Profile> {
    if (!PROVIDER_IDS.includes(provider))
      throw new IronProxyError('INVALID_REQUEST', `Unknown provider "${provider}".`, {
        hint: `Use one of: ${PROVIDER_IDS.join(', ')}.`,
      });
    const lane = opts.lane ?? 'cli';
    const onLane = (p: Profile) => lane === 'any' || p.lane === lane;
    if (opts.profileId) {
      const p = await this.getProfile(opts.profileId);
      if (p.provider !== provider || !onLane(p))
        throw new IronProxyError(
          'INVALID_REQUEST',
          `Profile "${p.title}" is a ${p.provider} ${p.lane} account, not a ${provider}${lane === 'any' ? '' : ` ${lane}`} one.`,
          {
            details: { profileId: p.id, provider: p.provider, lane: p.lane },
            hint: `Pick one of the ${provider} accounts that iron-proxy profiles list shows${lane === 'any' ? '' : ` with lane ${lane}`}.`,
          },
        );
      if (!p.enabled)
        throw new IronProxyError('INVALID_REQUEST', `Profile "${p.title}" is disabled.`, {
          details: { profileId: p.id },
          hint: `Enable it first: iron-proxy profiles enable ${p.id}.`,
        });
      await this.router.availability(p, { profileId: p.id });
      return p;
    }
    const candidates = (await this.router.candidates(provider)).filter(onLane);
    if (!candidates.length) throw new NoProfileError(provider);
    let earliest: string | undefined;
    let parked = false;
    let signedOut: Profile | undefined;
    for (const p of candidates) {
      const { usable, state } = await this.router.availability(p);
      if (usable) return p;
      if (state.status === 'parked') {
        parked = true;
        const until = state.parkedUntil;
        if (until && (!earliest || until < earliest)) earliest = until;
      } else if (state.status === 'unauthenticated') signedOut ??= p;
    }
    if (parked)
      throw new AllProfilesExhaustedError(
        provider,
        earliest,
        candidates.map((p) => p.id),
      );
    if (signedOut)
      throw new AuthRequiredError(
        signedOut.id,
        `Every ${provider} account needs to log in again.`,
        { title: signedOut.title, lane: signedOut.lane },
      );
    throw new NoProfileError(provider);
  }

  /**
   * The command that starts this CLI profile's vendor CLI interactively, `args`
   * appended, with the lane's scrubbed environment. Creates an isolated home that
   * is missing; never touches an adopted one.
   */
  async interactiveCommand(
    id: string,
    args: string[] = [],
  ): Promise<{ binary: string; args: string[]; env: Record<string, string> }> {
    const p = await this.getProfile(id);
    const lane = this.cliLaneOf(p);
    await lane.ensureHome(p);
    return lane.interactiveCommand(p, args);
  }

  /** The variables a user's own shell sets and clears to run this CLI profile's vendor CLI. */
  async shellEnv(id: string): Promise<{ set: Record<string, string>; unset: string[] }> {
    const p = await this.getProfile(id);
    return this.cliLaneOf(p).shellEnv(p);
  }

  private cliLaneOf(p: Profile): CliLane {
    const lane = p.lane === 'cli' ? this.registry.laneFor(p) : undefined;
    if (!(lane instanceof CliLane))
      throw new IronProxyError('UNSUPPORTED', `Profile "${p.title}" is not a vendor CLI account.`, {
        details: { profileId: p.id, lane: p.lane },
        hint: 'Pick a cli-lane account; API-key accounts are used through iron-proxy chat or the proxy.',
      });
    return lane;
  }

  /* ---------------------------------------------------------------- */
  /* State + diagnostics                                              */
  /* ---------------------------------------------------------------- */

  async allStates(): Promise<Record<string, ProfileState>> {
    const states = await this.states.all();
    for (const p of await this.profiles.list())
      states[p.id] ??= { profileId: p.id, status: 'unknown', served: 0 };
    return states;
  }

  unpark(id: string): Promise<void> {
    return this.router.unpark(id);
  }

  /**
   * Requests and tokens per profile over the last 1h / 5h / 24h / 7d, parks this
   * week, the latest utilisation of the current window and, when at least three
   * samples of that window show a rising trend, an estimate of the minutes left
   * at this pace. Reads local history only; never calls a provider.
   */
  async usageReport(opts: { profileId?: string } = {}): Promise<UsageReport[]> {
    const targets = opts.profileId
      ? [await this.getProfile(opts.profileId)]
      : await this.listProfiles();
    // Snapshots a lane reported are stored by the router first, then recorded here.
    await this.router.settleUsage();
    await Promise.all([...this.usageWrites]);
    const now = this.clock.now();
    return Promise.all(
      targets.map(async (p) => buildUsageReport(p.id, await this.usage.history(p.id), now)),
    );
  }

  activeProfileId(provider: ProviderId): string | undefined {
    return this.router.activeProfileId(provider);
  }

  async listModels(id: string): Promise<string[]> {
    const p = await this.getProfile(id);
    const lane = this.registry.laneFor(p);
    if (!lane.listModels) return [];
    const controller = new AbortController();
    return lane.listModels(p, {
      profile: p,
      vault: this.vault,
      fetch: (input, init) => fetch(input, init),
      signal: controller.signal,
      now: () => this.clock.now(),
      reportUsage: () => {},
    });
  }

  /** Which vendor CLIs are installed on this machine. */
  async doctor(): Promise<CliProbe[]> {
    return Promise.all(
      CLI_SPECS.map(async (spec) => {
        const path = await which(spec.binary);
        const probe: CliProbe = {
          provider: spec.provider,
          binary: spec.binary,
          found: !!path,
          homeEnv: spec.homeEnv,
        };
        if (path) {
          probe.path = path;
          const r = await run({
            binary: path,
            args: ['--version'],
            env: { ...process.env } as Record<string, string>,
            timeoutMs: 15_000,
          }).catch(() => undefined);
          const v = r?.stdout.trim().split('\n')[0];
          if (v) probe.version = v;
        }
        return probe;
      }),
    );
  }

  /**
   * Cancel logins, wait for usage still being stored, then flush debounced state
   * and the usage store (`UsageStore.flush`, when it has one). Call on app quit.
   */
  async close(): Promise<void> {
    for (const s of this.logins.values()) s.cancel();
    this.logins.clear();
    // Let usage the router is still storing reach the history before unsubscribing.
    await this.router.settleUsage();
    for (const off of this.usageOff.splice(0)) off();
    await Promise.all([...this.usageWrites]);
    await this.usage.flush?.().catch(() => {});
    if (this.states instanceof FileStateStore) await this.states.flush();
    this.events.removeAll();
  }
}

function freeTitle(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const t = `${base} ${n}`;
    if (!taken.has(t)) return t;
  }
}

export function createIronProxy(opts: IronProxyOptions = {}): IronProxy {
  return new IronProxy(opts);
}
