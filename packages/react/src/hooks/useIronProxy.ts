import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  IronClient,
  IronEvent,
  LoginCommandInfo,
  Profile,
  ProfileInput,
  ProfileState,
  ProviderId,
  ProviderInfo,
} from '@iron-proxy/core';
import { groupByProvider } from '../util.js';
import { toClientError, type ClientError } from '../util.js';

export interface LoginProgress {
  urls: string[];
  codes: string[];
  lines: string[];
  status: 'idle' | 'running' | 'done' | 'failed';
  message?: string;
}

export interface ExhaustedInfo {
  at: string;
  earliestResetAt?: string;
}

export interface IronActions {
  create(input: ProfileInput & { apiKeySecret?: string }): Promise<Profile | undefined>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(provider: ProviderId, ids: string[]): Promise<void>;
  moveUp(id: string): Promise<void>;
  moveDown(id: string): Promise<void>;
  activate(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  setApiKey(id: string, secret: string): Promise<void>;
  login(id: string): Promise<void>;
  cancelLogin(id: string): Promise<void>;
  loginCommand(id: string): Promise<LoginCommandInfo | undefined>;
  logout(id: string): Promise<void>;
  refresh(id?: string): Promise<void>;
  unpark(id: string): Promise<void>;
  listModels(id: string): Promise<string[]>;
  clearError(): void;
  dismissExhausted(provider: ProviderId): void;
}

export interface IronProxyView {
  providers: ProviderInfo[];
  profiles: Profile[];
  states: Record<string, ProfileState>;
  loading: boolean;
  error: ClientError | undefined;
  activeByProvider: Partial<Record<ProviderId, string>>;
  loginProgress: Record<string, LoginProgress>;
  exhausted: Partial<Record<ProviderId, ExhaustedInfo>>;
  actions: IronActions;
}

export interface UseIronProxyOptions {
  /** Raw event tap, e.g. to react to `request.finished`. */
  onEvent?: (event: IronEvent) => void;
}

const emptyProgress = (): LoginProgress => ({ urls: [], codes: [], lines: [], status: 'idle' });

/**
 * Loads providers, profiles and states once, then keeps them current from the
 * client's event stream without refetching.
 */
export function useIronProxy(client: IronClient, opts: UseIronProxyOptions = {}): IronProxyView {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [states, setStates] = useState<Record<string, ProfileState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ClientError | undefined>();
  const [activeByProvider, setActiveByProvider] = useState<Partial<Record<ProviderId, string>>>({});
  const [loginProgress, setLoginProgress] = useState<Record<string, LoginProgress>>({});
  const [exhausted, setExhausted] = useState<Partial<Record<ProviderId, ExhaustedInfo>>>({});
  const onEventRef = useRef(opts.onEvent);
  onEventRef.current = opts.onEvent;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [prov, profs, sts] = await Promise.all([
        client.providers(),
        client.listProfiles(),
        client.states(),
      ]);
      setProviders(prov);
      setProfiles(profs);
      setStates(sts);
      const active: Partial<Record<ProviderId, string>> = {};
      for (const p of profs) if (sts[p.id]?.status === 'active') active[p.provider] = p.id;
      setActiveByProvider(active);
      setError(undefined);
    } catch (err) {
      setError(toClientError(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    let alive = true;
    void load();
    const off = client.onEvent((event) => {
      if (!alive) return;
      onEventRef.current?.(event);
      switch (event.type) {
        case 'profile.created':
          setProfiles((ps) =>
            ps.some((p) => p.id === event.profile.id) ? ps : [...ps, event.profile],
          );
          break;
        case 'profile.updated':
          setProfiles((ps) => {
            const i = ps.findIndex((p) => p.id === event.profile.id);
            if (i < 0) return [...ps, event.profile];
            const next = ps.slice();
            next[i] = event.profile;
            return next;
          });
          break;
        case 'profile.deleted':
          setProfiles((ps) => ps.filter((p) => p.id !== event.profileId));
          setStates((s) => {
            if (!(event.profileId in s)) return s;
            const { [event.profileId]: _gone, ...rest } = s;
            return rest;
          });
          setLoginProgress((lp) => {
            if (!(event.profileId in lp)) return lp;
            const { [event.profileId]: _gone, ...rest } = lp;
            return rest;
          });
          break;
        case 'profile.state':
          setStates((s) => ({ ...s, [event.state.profileId]: event.state }));
          if (event.state.status === 'active') {
            setProfiles((ps) => {
              const p = ps.find((x) => x.id === event.state.profileId);
              if (p)
                setActiveByProvider((a) =>
                  a[p.provider] === p.id ? a : { ...a, [p.provider]: p.id },
                );
              return ps;
            });
          }
          break;
        case 'profile.parked':
          setStates((s) => {
            const cur = s[event.profileId] ?? {
              profileId: event.profileId,
              status: 'unknown',
              served: 0,
            };
            return {
              ...s,
              [event.profileId]: {
                ...cur,
                status: 'parked',
                parkedReason: event.reason,
                ...(event.until ? { parkedUntil: event.until } : {}),
              },
            };
          });
          break;
        case 'profile.unparked':
          setStates((s) => {
            const cur = s[event.profileId];
            if (!cur || cur.status !== 'parked') return s;
            const { parkedUntil: _u, parkedReason: _r, ...rest } = cur;
            return { ...s, [event.profileId]: { ...rest, status: 'ready' } };
          });
          break;
        case 'profile.switched':
          setActiveByProvider((a) => ({ ...a, [event.provider]: event.toProfileId }));
          setExhausted((e) => {
            if (!(event.provider in e)) return e;
            const { [event.provider]: _gone, ...rest } = e;
            return rest;
          });
          break;
        case 'provider.exhausted':
          setExhausted((e) => ({
            ...e,
            [event.provider]: {
              at: new Date().toISOString(),
              ...(event.earliestResetAt ? { earliestResetAt: event.earliestResetAt } : {}),
            },
          }));
          break;
        case 'login': {
          const le = event.event;
          setLoginProgress((lp) => {
            const cur = lp[le.profileId] ?? emptyProgress();
            let next: LoginProgress = cur;
            switch (le.type) {
              case 'started':
                next = { ...emptyProgress(), status: 'running' };
                break;
              case 'url':
                next = {
                  ...cur,
                  status: 'running',
                  urls: cur.urls.includes(le.url) ? cur.urls : [...cur.urls, le.url],
                };
                break;
              case 'code':
                next = {
                  ...cur,
                  status: 'running',
                  codes: cur.codes.includes(le.code) ? cur.codes : [...cur.codes, le.code],
                };
                break;
              case 'output':
                next = { ...cur, lines: [...cur.lines.slice(-49), le.line] };
                break;
              case 'completed':
                next = { ...cur, status: 'done' };
                break;
              case 'failed':
                next = { ...cur, status: 'failed', message: le.message };
                break;
              case 'cancelled':
                next = { ...cur, status: 'idle' };
                break;
            }
            return { ...lp, [le.profileId]: next };
          });
          break;
        }
        default:
          break;
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, load]);

  const guard = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      const r = await fn();
      setError(undefined);
      return r;
    } catch (err) {
      setError(toClientError(err));
      return undefined;
    }
  }, []);

  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const actions = useMemo<IronActions>(() => {
    const neighbours = (id: string) => {
      const p = profilesRef.current.find((x) => x.id === id);
      if (!p) return undefined;
      const group = groupByProvider(profilesRef.current).find((g) => g.provider === p.provider);
      if (!group) return undefined;
      const ids = group.profiles.map((x) => x.id);
      return { provider: p.provider, ids, index: ids.indexOf(id) };
    };
    const swap = async (id: string, delta: -1 | 1) => {
      const n = neighbours(id);
      if (!n) return;
      const j = n.index + delta;
      if (j < 0 || j >= n.ids.length) return;
      const ids = n.ids.slice();
      [ids[n.index], ids[j]] = [ids[j]!, ids[n.index]!];
      await guard(() => client.reorder(n.provider, ids));
    };
    return {
      create: (input) => guard(() => client.createProfile(input)),
      rename: async (id, title) => void (await guard(() => client.updateProfile(id, { title }))),
      remove: async (id) => void (await guard(() => client.deleteProfile(id))),
      reorder: async (provider, ids) => void (await guard(() => client.reorder(provider, ids))),
      moveUp: (id) => swap(id, -1),
      moveDown: (id) => swap(id, 1),
      activate: async (id) => void (await guard(() => client.activate(id))),
      setEnabled: async (id, enabled) =>
        void (await guard(() => client.updateProfile(id, { enabled }))),
      setApiKey: async (id, secret) => void (await guard(() => client.setApiKey(id, secret))),
      login: async (id) => {
        setLoginProgress((lp) => ({ ...lp, [id]: { ...emptyProgress(), status: 'running' } }));
        try {
          await client.login(id);
          setLoginProgress((lp) => ({
            ...lp,
            [id]: { ...(lp[id] ?? emptyProgress()), status: 'done' },
          }));
        } catch (err) {
          const e = toClientError(err);
          setLoginProgress((lp) => ({
            ...lp,
            [id]: { ...(lp[id] ?? emptyProgress()), status: 'failed', message: e.message },
          }));
        }
      },
      cancelLogin: async (id) => {
        await guard(() => client.cancelLogin(id));
        setLoginProgress((lp) => ({
          ...lp,
          [id]: { ...(lp[id] ?? emptyProgress()), status: 'idle' },
        }));
      },
      loginCommand: (id) => guard(() => client.loginCommand(id)),
      logout: async (id) => void (await guard(() => client.logout(id))),
      refresh: async (id) => {
        if (id) await guard(() => client.refreshStatus(id));
        else await load();
      },
      unpark: async (id) => void (await guard(() => client.unpark(id))),
      listModels: async (id) => (await guard(() => client.listModels(id))) ?? [],
      clearError: () => setError(undefined),
      dismissExhausted: (provider) =>
        setExhausted((e) => {
          const { [provider]: _gone, ...rest } = e;
          return rest;
        }),
    };
  }, [client, guard, load]);

  return {
    providers,
    profiles,
    states,
    loading,
    error,
    activeByProvider,
    loginProgress,
    exhausted,
    actions,
  };
}
