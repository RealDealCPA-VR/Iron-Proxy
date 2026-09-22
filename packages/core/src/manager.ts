import { homedir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type {
  CliProbe,
  FailoverPolicy,
  IronEvent,
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
} from './types.js';
import { PROVIDER_IDS } from './types.js';
import { IronProxyError, ProfileNotFoundError } from './errors.js';
import { TypedEmitter, type IronEmitter } from './events.js';
import { createDefaultRegistry } from './adapters/index.js';
import type { AdapterRegistry, FetchLike } from './adapters/types.js';
import { CliLane } from './adapters/cli/lane.js';
import { CLI_SPECS } from './adapters/cli/specs.js';
import { run, which } from './adapters/cli/runner.js';
import { Router } from './router/router.js';
import { FileProfileStore, type ProfileStore } from './store/profile-store.js';
import { FileStateStore, type StateStore } from './store/state-store.js';
import { FileVault, type KeyProtector, type Vault } from './vault/vault.js';
import { isoNow, newId, systemClock, type Clock } from './util.js';

export interface IronProxyOptions {
  /** Where profiles, state, the vault and isolated CLI homes live. Default `~/.iron-proxy`. */
  dataDir?: string;
  profiles?: ProfileStore;
  states?: StateStore;
  vault?: Vault;
  /** Used only when `vault` is not given, to protect the file vault's key. */
  keyProtector?: KeyProtector;
  registry?: AdapterRegistry;
  policy?: Partial<FailoverPolicy>;
  clock?: Clock;
  fetch?: FetchLike;
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
  readonly vault: Vault;
  readonly registry: AdapterRegistry;
  readonly events: IronEmitter;
  readonly router: Router;
  private readonly clock: Clock;
  private readonly logins = new Map<string, LoginSession>();

  constructor(opts: IronProxyOptions = {}) {
    this.dataDir = opts.dataDir ?? defaultDataDir();
    this.profiles = opts.profiles ?? new FileProfileStore(this.dataDir);
    this.states = opts.states ?? new FileStateStore(this.dataDir);
    this.vault = opts.vault ?? new FileVault(this.dataDir, opts.keyProtector);
    this.registry = opts.registry ?? createDefaultRegistry();
    this.events = new TypedEmitter<IronEvent>();
    this.clock = opts.clock ?? systemClock;
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
  async createProfile(input: ProfileInput & { apiKeySecret?: string }): Promise<Profile> {
    if (!PROVIDER_IDS.includes(input.provider)) {
      throw new IronProxyError('INVALID_REQUEST', `Unknown provider "${input.provider}".`);
    }
    if (!input.title?.trim())
      throw new IronProxyError('INVALID_REQUEST', 'A profile needs a title.');
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
      const secretRef = input.apiKey?.secretRef ?? `apikey:${id}`;
      profile.apiKey = { ...(input.apiKey ?? {}), secretRef };
      if (input.provider === 'openai-compatible' && !profile.apiKey.baseUrl) {
        throw new IronProxyError(
          'INVALID_REQUEST',
          'An openai-compatible profile needs apiKey.baseUrl.',
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
    void this.refreshStatus(id).catch(() => {});
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
    if (patch.cli && p.cli) p.cli = { ...p.cli, ...patch.cli };
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

  /** Delete the profile, its secrets and (for CLI profiles) its isolated home directory. */
  async deleteProfile(id: string, opts: { keepFiles?: boolean } = {}): Promise<void> {
    const p = await this.getProfile(id);
    this.logins.get(id)?.cancel();
    if (p.apiKey?.secretRef) await this.vault.delete(p.apiKey.secretRef).catch(() => {});
    if (p.oauth?.secretRef) await this.vault.delete(p.oauth.secretRef).catch(() => {});
    if (p.cli?.home && !opts.keepFiles && p.cli.home.startsWith(join(this.dataDir, 'cli-homes'))) {
      await rm(p.cli.home, { recursive: true, force: true }).catch(() => {});
    }
    await this.profiles.delete(id);
    await this.states.delete(id);
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
      throw new IronProxyError('INVALID_REQUEST', 'Profile is not an API-key profile.');
    await this.vault.set(p.apiKey.secretRef, secret);
    const st = await this.router.state(id);
    st.status = 'ready';
    delete st.lastError;
    await this.states.put(st);
    this.events.emit({ type: 'profile.state', state: st });
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

  /** Flush debounced state and cancel logins. Call on app quit. */
  async close(): Promise<void> {
    for (const s of this.logins.values()) s.cancel();
    this.logins.clear();
    if (this.states instanceof FileStateStore) await this.states.flush();
    this.events.removeAll();
  }
}

export function createIronProxy(opts: IronProxyOptions = {}): IronProxy {
  return new IronProxy(opts);
}
