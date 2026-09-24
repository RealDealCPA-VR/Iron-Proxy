import type { IronProxy } from './manager.js';
import type {
  AdoptLoginInput,
  CliProbe,
  DiscoveredLogin,
  IronEvent,
  LaneKind,
  Profile,
  ProfileInput,
  ProfilePatch,
  ProfileState,
  ProviderId,
} from './types.js';

export interface ProviderInfo {
  id: ProviderId;
  displayName: string;
  defaultModel: string;
  lanes: LaneKind[];
}

export interface LoginCommandInfo {
  binary: string;
  args: string[];
  env: Record<string, string>;
  requiresTerminal: boolean;
}

/**
 * The control surface every UI talks to, whatever the transport: direct
 * (Electron main, tests), IPC (Electron renderer via preload) or HTTP (the
 * local proxy's control API). Request execution is deliberately not part of
 * it; that goes through `IronProxy.complete/stream` or the proxy endpoints.
 */
export interface IronClient {
  providers(): Promise<ProviderInfo[]>;
  listProfiles(): Promise<Profile[]>;
  states(): Promise<Record<string, ProfileState>>;
  createProfile(input: ProfileInput & { apiKeySecret?: string }): Promise<Profile>;
  updateProfile(id: string, patch: ProfilePatch): Promise<Profile>;
  deleteProfile(id: string): Promise<void>;
  reorder(provider: ProviderId, ids: string[]): Promise<Profile[]>;
  activate(id: string): Promise<Profile>;
  setApiKey(id: string, secret: string): Promise<void>;
  /** Starts a login and resolves when it completes. Progress arrives as `login` events. */
  login(id: string): Promise<void>;
  cancelLogin(id: string): Promise<void>;
  loginCommand(id: string): Promise<LoginCommandInfo>;
  logout(id: string): Promise<void>;
  refreshStatus(id?: string): Promise<ProfileState[]>;
  unpark(id: string): Promise<void>;
  listModels(id: string): Promise<string[]>;
  doctor(): Promise<CliProbe[]>;
  /** Vendor CLIs already signed in at their default home on this machine. */
  discoverLogins(): Promise<DiscoveredLogin[]>;
  /** Make a profile that uses an existing CLI login in place. No second login, nothing copied. */
  adoptLogin(input: AdoptLoginInput): Promise<Profile>;
  onEvent(listener: (event: IronEvent) => void): () => void;
}

/** In-process client: the manager itself, behind the IronClient shape. */
export class LocalIronClient implements IronClient {
  private readonly sessions = new Map<string, { cancel(): void }>();
  constructor(private readonly iron: IronProxy) {}

  async providers(): Promise<ProviderInfo[]> {
    return this.iron.registry.list().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      defaultModel: a.defaultModel,
      lanes: Object.keys(a.lanes) as LaneKind[],
    }));
  }
  listProfiles() {
    return this.iron.listProfiles();
  }
  states() {
    return this.iron.allStates();
  }
  createProfile(input: ProfileInput & { apiKeySecret?: string }) {
    return this.iron.createProfile(input);
  }
  updateProfile(id: string, patch: ProfilePatch) {
    return this.iron.updateProfile(id, patch);
  }
  deleteProfile(id: string) {
    return this.iron.deleteProfile(id);
  }
  reorder(provider: ProviderId, ids: string[]) {
    return this.iron.reorder(provider, ids);
  }
  activate(id: string) {
    return this.iron.activate(id);
  }
  setApiKey(id: string, secret: string) {
    return this.iron.setApiKey(id, secret);
  }
  async login(id: string): Promise<void> {
    const session = await this.iron.login(id);
    this.sessions.set(id, session);
    try {
      await session.done;
    } finally {
      this.sessions.delete(id);
    }
  }
  async cancelLogin(id: string): Promise<void> {
    this.sessions.get(id)?.cancel();
  }
  loginCommand(id: string) {
    return this.iron.loginCommand(id);
  }
  logout(id: string) {
    return this.iron.logout(id);
  }
  refreshStatus(id?: string) {
    return this.iron.refreshStatus(id);
  }
  unpark(id: string) {
    return this.iron.unpark(id);
  }
  listModels(id: string) {
    return this.iron.listModels(id);
  }
  doctor() {
    return this.iron.doctor();
  }
  discoverLogins() {
    return this.iron.discoverLogins();
  }
  adoptLogin(input: AdoptLoginInput) {
    return this.iron.adoptLogin(input);
  }
  onEvent(listener: (event: IronEvent) => void): () => void {
    return this.iron.events.onAny(listener);
  }
}

/** Method names of IronClient, for transports that map calls generically. */
export const IRON_CLIENT_METHODS = [
  'providers',
  'listProfiles',
  'states',
  'createProfile',
  'updateProfile',
  'deleteProfile',
  'reorder',
  'activate',
  'setApiKey',
  'login',
  'cancelLogin',
  'loginCommand',
  'logout',
  'refreshStatus',
  'unpark',
  'listModels',
  'doctor',
  'discoverLogins',
  'adoptLogin',
] as const satisfies ReadonlyArray<Exclude<keyof IronClient, 'onEvent'>>;

export type IronClientMethod = (typeof IRON_CLIENT_METHODS)[number];
