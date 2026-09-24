import { useCallback, useEffect, useRef, useState } from 'react';
import type { IronClient, UsageReport } from '@iron-proxy/core';
import { toClientError, type ClientError } from '../util.js';

export interface UseUsageReportOptions {
  /** Also reload on this interval (ms). Off by default; reads local history only. */
  refreshMs?: number;
  /** Wait this long after a `request.finished` / `profile.parked` event before reloading. Default 400. */
  debounceMs?: number;
  /** Only this profile. */
  profileId?: string;
  /** Skip loading entirely (e.g. while a panel is hidden). Default true. */
  enabled?: boolean;
}

export interface UsageReportView {
  reports: UsageReport[];
  loading: boolean;
  error: ClientError | undefined;
  /** False when the client has no `usageReport` (an older host). */
  supported: boolean;
  reload(): Promise<void>;
}

/**
 * Loads `client.usageReport()` and reloads it, debounced, after every
 * `request.finished` or `profile.parked` event, plus on `refreshMs` when given.
 * Never calls a provider: the report is built from local history.
 */
export function useUsageReport(
  client: IronClient,
  opts: UseUsageReportOptions = {},
): UsageReportView {
  const { refreshMs, debounceMs = 400, profileId, enabled = true } = opts;
  const supported = typeof (client as Partial<IronClient>).usageReport === 'function';
  const [reports, setReports] = useState<UsageReport[]>([]);
  const [loading, setLoading] = useState(enabled && supported);
  const [error, setError] = useState<ClientError | undefined>();
  const alive = useRef(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!supported) return;
    const mine = ++seq.current;
    try {
      const next = await client.usageReport(profileId);
      if (!alive.current || mine !== seq.current) return;
      setReports(next);
      setError(undefined);
    } catch (err) {
      if (!alive.current || mine !== seq.current) return;
      setError(toClientError(err));
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
  }, [client, profileId, supported]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !supported) return;
    setLoading(true);
    void reload();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.onEvent((e) => {
      if (e.type !== 'request.finished' && e.type !== 'profile.parked') return;
      if (profileId && e.profileId !== profileId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void reload();
      }, debounceMs);
    });
    const interval =
      refreshMs && refreshMs > 0 ? setInterval(() => void reload(), refreshMs) : undefined;
    return () => {
      off();
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }, [client, enabled, supported, reload, debounceMs, refreshMs, profileId]);

  return { reports, loading: enabled && supported && loading, error, supported, reload };
}
