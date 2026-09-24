import type {
  AdoptLoginInput,
  CliProbe,
  DiscoveredLogin,
  IronClient,
  IronEvent,
  LoginCommandInfo,
  Profile,
  ProfileInput,
  ProfilePatch,
  ProfileState,
  ProviderId,
  ProviderInfo,
  UsageReport,
} from '@iron-proxy/core';

/** In-memory IronClient that emits the same events the real manager does. */
export class FakeIronClient implements IronClient {
  profiles = new Map<string, Profile>();
  stateMap = new Map<string, ProfileState>();
  secrets = new Map<string, string>();
  calls: string[] = [];
  private listeners = new Set<(e: IronEvent) => void>();
  private seq = 0;
  /** Resolvers for pending logins, keyed by profile id. */
  pendingLogins = new Map<string, { resolve(): void; reject(e: Error): void }>();
  /** What discoverLogins reports (existing CLI logins on "this computer"). */
  discovered: DiscoveredLogin[] = [];
  /** What usageReport returns (all profiles; filtered by id when asked). */
  usage: UsageReport[] = [];

  emit(e: IronEvent): void {
    for (const l of this.listeners) l(e);
  }

  seed(
    p: Partial<Profile> & Pick<Profile, 'title' | 'provider'>,
    state?: Partial<ProfileState>,
  ): Profile {
    const id = p.id ?? `p${++this.seq}`;
    const siblings = [...this.profiles.values()].filter((x) => x.provider === p.provider);
    const profile: Profile = {
      id,
      lane: 'api-key',
      order: siblings.length,
      enabled: true,
      createdAt: 'x',
      updatedAt: 'x',
      ...p,
    };
    this.profiles.set(id, profile);
    this.stateMap.set(id, { profileId: id, status: 'ready', served: 0, ...(state ?? {}) });
    return profile;
  }

  async providers(): Promise<ProviderInfo[]> {
    this.calls.push('providers');
    return [
      {
        id: 'anthropic',
        displayName: 'Anthropic (Claude)',
        defaultModel: 'claude-sonnet-5',
        lanes: ['api-key', 'cli'],
      },
      {
        id: 'openai',
        displayName: 'OpenAI (ChatGPT / Codex)',
        defaultModel: 'gpt-5',
        lanes: ['api-key', 'cli'],
      },
      {
        id: 'openai-compatible',
        displayName: 'OpenAI-compatible endpoint',
        defaultModel: '',
        lanes: ['api-key'],
      },
    ];
  }
  async listProfiles(): Promise<Profile[]> {
    this.calls.push('listProfiles');
    return [...this.profiles.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.order - b.order,
    );
  }
  async states(): Promise<Record<string, ProfileState>> {
    return Object.fromEntries(this.stateMap);
  }
  async createProfile(input: ProfileInput & { apiKeySecret?: string }): Promise<Profile> {
    this.calls.push(
      `createProfile:${input.title}:${input.lane}:${input.apiKeySecret ? 'withKey' : 'noKey'}`,
    );
    const { apiKeySecret, ...rest } = input;
    const p = this.seed(
      { ...rest, id: `p${++this.seq}` } as Partial<Profile> & Pick<Profile, 'title' | 'provider'>,
      {
        status: input.lane === 'cli' ? 'unauthenticated' : 'ready',
      },
    );
    if (apiKeySecret) this.secrets.set(p.id, apiKeySecret);
    this.emit({ type: 'profile.created', profile: p });
    this.emit({ type: 'profile.state', state: this.stateMap.get(p.id)! });
    return p;
  }
  async updateProfile(id: string, patch: ProfilePatch): Promise<Profile> {
    this.calls.push(`updateProfile:${id}:${JSON.stringify(patch)}`);
    const p = { ...this.profiles.get(id)!, ...patch } as Profile;
    this.profiles.set(id, p);
    this.emit({ type: 'profile.updated', profile: p });
    return p;
  }
  async deleteProfile(id: string): Promise<void> {
    this.calls.push(`deleteProfile:${id}`);
    this.profiles.delete(id);
    this.stateMap.delete(id);
    this.emit({ type: 'profile.deleted', profileId: id });
  }
  async reorder(provider: ProviderId, ids: string[]): Promise<Profile[]> {
    this.calls.push(`reorder:${provider}:${ids.join(',')}`);
    const out: Profile[] = [];
    ids.forEach((id, i) => {
      const p = this.profiles.get(id);
      if (!p) return;
      const next = { ...p, order: i };
      this.profiles.set(id, next);
      this.emit({ type: 'profile.updated', profile: next });
      out.push(next);
    });
    return out;
  }
  async activate(id: string): Promise<Profile> {
    this.calls.push(`activate:${id}`);
    const p = this.profiles.get(id)!;
    const rest = [...this.profiles.values()]
      .filter((x) => x.provider === p.provider && x.id !== id)
      .map((x) => x.id);
    await this.reorder(p.provider, [id, ...rest]);
    for (const s of this.stateMap.values()) {
      if (this.profiles.get(s.profileId)?.provider === p.provider && s.status === 'active') {
        s.status = 'ready';
        this.emit({ type: 'profile.state', state: { ...s } });
      }
    }
    const st = this.stateMap.get(id)!;
    st.status = 'active';
    this.emit({ type: 'profile.state', state: { ...st } });
    this.emit({ type: 'profile.switched', provider: p.provider, toProfileId: id });
    return this.profiles.get(id)!;
  }
  async setApiKey(id: string, secret: string): Promise<void> {
    this.calls.push(`setApiKey:${id}`);
    this.secrets.set(id, secret);
  }
  login(id: string): Promise<void> {
    this.calls.push(`login:${id}`);
    this.emit({ type: 'login', event: { type: 'started', profileId: id, method: 'fake' } });
    return new Promise<void>((resolve, reject) => {
      this.pendingLogins.set(id, {
        resolve: () => {
          const st = this.stateMap.get(id);
          if (st) {
            st.status = 'ready';
            this.emit({ type: 'profile.state', state: { ...st } });
          }
          this.emit({ type: 'login', event: { type: 'completed', profileId: id } });
          resolve();
        },
        reject: (e) => {
          this.emit({
            type: 'login',
            event: { type: 'failed', profileId: id, message: e.message },
          });
          reject(e);
        },
      });
    });
  }
  /** Test helper: the fake CLI printed a URL and a code. */
  loginProgress(id: string, url: string, code: string): void {
    this.emit({ type: 'login', event: { type: 'url', profileId: id, url } });
    this.emit({ type: 'login', event: { type: 'code', profileId: id, code } });
  }
  async cancelLogin(id: string): Promise<void> {
    this.calls.push(`cancelLogin:${id}`);
    this.pendingLogins.get(id)?.reject(new Error('cancelled'));
    this.pendingLogins.delete(id);
  }
  async loginCommand(id: string): Promise<LoginCommandInfo> {
    this.calls.push(`loginCommand:${id}`);
    return {
      binary: 'claude',
      args: ['auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: `/homes/${id}`, PATH: '/usr/bin' },
      requiresTerminal: false,
    };
  }
  async logout(id: string): Promise<void> {
    this.calls.push(`logout:${id}`);
    const st = this.stateMap.get(id)!;
    st.status = 'unauthenticated';
    this.emit({ type: 'profile.state', state: { ...st } });
  }
  async refreshStatus(id?: string): Promise<ProfileState[]> {
    this.calls.push(`refreshStatus:${id ?? '*'}`);
    return [...this.stateMap.values()];
  }
  async unpark(id: string): Promise<void> {
    this.calls.push(`unpark:${id}`);
    const st = this.stateMap.get(id)!;
    st.status = 'ready';
    delete st.parkedUntil;
    delete st.parkedReason;
    this.emit({ type: 'profile.unparked', profileId: id });
    this.emit({ type: 'profile.state', state: { ...st } });
  }
  async listModels(): Promise<string[]> {
    return ['m1'];
  }
  async doctor(): Promise<CliProbe[]> {
    return [];
  }
  async discoverLogins(): Promise<DiscoveredLogin[]> {
    this.calls.push('discoverLogins');
    return this.discovered.map((d) => {
      const owner = [...this.profiles.values()].find((p) => p.cli?.home === d.home);
      return owner ? { ...d, adoptedProfileId: owner.id } : { ...d };
    });
  }
  async adoptLogin(input: AdoptLoginInput): Promise<Profile> {
    this.calls.push(`adoptLogin:${input.provider}:${input.home}:${input.title ?? ''}`);
    if ([...this.profiles.values()].some((p) => p.cli?.home === input.home))
      throw Object.assign(new Error(`A profile already uses "${input.home}".`), {
        code: 'INVALID_REQUEST',
        hint: 'Use the existing profile.',
      });
    const p = this.seed(
      {
        title: input.title ?? 'Existing login',
        provider: input.provider,
        lane: 'cli',
        cli: { home: input.home, adopted: true },
      },
      { status: 'ready' },
    );
    this.emit({ type: 'profile.created', profile: p });
    this.emit({ type: 'profile.state', state: this.stateMap.get(p.id)! });
    return p;
  }
  async usageReport(profileId?: string): Promise<UsageReport[]> {
    this.calls.push(`usageReport:${profileId ?? '*'}`);
    return structuredClone(
      profileId ? this.usage.filter((r) => r.profileId === profileId) : this.usage,
    );
  }
  onEvent(listener: (e: IronEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
