import { useContext, useEffect, useMemo, useState } from 'react';
import type { IronClient, Profile, ProviderId, UsageReport, UsageWindow } from '@iron-proxy/core';
import { useUsageReport } from '../hooks/useUsageReport.js';
import { useInjectedStyles } from '../inject-styles.js';
import { defaultLabels, interpolate, type Labels } from '../labels.js';
import { formatCount, PROVIDER_SHORT } from '../util.js';
import { ErrorBanner } from './bits.jsx';
import { SwitcherContext } from './context.js';

export interface UsagePanelProps {
  client: IronClient;
  /** Only this account. */
  profileId?: string;
  /** Only accounts of these providers. */
  providers?: ProviderId[];
  /** Also reload on this interval (ms). Events already trigger a reload. */
  refreshMs?: number;
  /** Override any user-visible string (inside <AccountSwitcher> its labels are used). */
  labels?: Partial<Labels>;
  /** Standalone only: inject the stylesheet into <head>. */
  injectStyles?: boolean;
  /** Standalone only: force a theme instead of following the OS. */
  theme?: 'light' | 'dark';
  className?: string;
}

const BAR_WINDOWS: ReadonlyArray<UsageWindow> = ['5h', '24h', '7d'];

/**
 * Per account: requests in the last 5h / 24h / 7d as small bars, this week's
 * tokens, parks this week and, when the trend supports one, "About 40 min left
 * at this pace". Renders inside <AccountSwitcher> (its "Usage" button) or on its own.
 */
export function UsagePanel({
  client,
  profileId,
  providers,
  refreshMs,
  labels: labelOverrides,
  injectStyles = true,
  theme,
  className,
}: UsagePanelProps) {
  const ctx = useContext(SwitcherContext);
  const standalone = !ctx;
  useInjectedStyles(standalone && injectStyles);
  const labels = useMemo<Labels>(
    () => ({ ...(ctx?.labels ?? defaultLabels), ...(labelOverrides ?? {}) }),
    [ctx?.labels, labelOverrides],
  );
  const view = useUsageReport(client, {
    ...(refreshMs !== undefined ? { refreshMs } : {}),
    ...(profileId !== undefined ? { profileId } : {}),
  });

  // Titles come from the switcher when inside it, else from the client.
  const [ownProfiles, setOwnProfiles] = useState<Profile[]>([]);
  useEffect(() => {
    if (!standalone) return;
    let alive = true;
    const load = () =>
      client
        .listProfiles()
        .then((ps) => alive && setOwnProfiles(ps))
        .catch(() => {});
    void load();
    const off = client.onEvent((e) => {
      if (
        e.type === 'profile.created' ||
        e.type === 'profile.updated' ||
        e.type === 'profile.deleted'
      )
        void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, standalone]);
  const profiles = ctx ? ctx.view.profiles : ownProfiles;
  const byId = useMemo(() => new Map(profiles.map((p) => [p.id, p])), [profiles]);

  const reports = useMemo(() => {
    const order = new Map(profiles.map((p, i) => [p.id, i]));
    return view.reports
      .filter((r) => !ctx || byId.has(r.profileId))
      .filter((r) => {
        const p = byId.get(r.profileId);
        return !providers || (p !== undefined && providers.includes(p.provider));
      })
      .slice()
      .sort((a, b) => (order.get(a.profileId) ?? 1e9) - (order.get(b.profileId) ?? 1e9));
  }, [view.reports, profiles, byId, ctx, providers]);
  const scale = Math.max(1, ...reports.map((r) => r.windows['7d'].requests));

  const windowLabel = (w: UsageWindow) =>
    w === '5h' ? labels.usageWindow5h : w === '24h' ? labels.usageWindow24h : labels.usageWindow7d;

  const body = (
    <section
      className={['iron-usage-panel', standalone ? '' : 'iron-usage-panel--inline']
        .filter(Boolean)
        .join(' ')}
      aria-label={labels.usageTitle}
      data-testid="usage-panel"
    >
      <div className="iron-usage-panel-head">
        <h3>{labels.usageTitle}</h3>
      </div>
      {view.loading && !reports.length ? (
        <div className="iron-empty" role="status">
          <span className="iron-spinner" aria-hidden /> {labels.usageLoading}
        </div>
      ) : null}
      {view.error ? <ErrorBanner error={view.error} labels={labels} /> : null}
      {!view.loading && !view.error && !reports.length ? (
        <div className="iron-empty">{labels.usageEmpty}</div>
      ) : null}
      {reports.map((r) => (
        <UsageAccount
          key={r.profileId}
          report={r}
          profile={byId.get(r.profileId)}
          providerName={(p) => ctx?.providerName(p.provider) ?? PROVIDER_SHORT[p.provider]}
          labels={labels}
          scale={scale}
          windowLabel={windowLabel}
        />
      ))}
    </section>
  );

  if (!standalone) return body;
  return (
    <div
      className={['iron-switcher', className ?? ''].filter(Boolean).join(' ')}
      {...(theme ? { 'data-theme': theme } : {})}
    >
      {body}
    </div>
  );
}

function UsageAccount({
  report,
  profile,
  providerName,
  labels,
  scale,
  windowLabel,
}: {
  report: UsageReport;
  profile: Profile | undefined;
  providerName(p: Profile): string;
  labels: Labels;
  scale: number;
  windowLabel(w: UsageWindow): string;
}) {
  const week = report.windows['7d'];
  const est = report.estimate;
  return (
    <div className="iron-usage-account" data-testid={`usage-${report.profileId}`}>
      <div className="iron-usage-account-head">
        <span className="iron-usage-account-title">{profile?.title ?? report.profileId}</span>
        {profile ? (
          <span className="iron-usage-account-provider">{providerName(profile)}</span>
        ) : null}
      </div>
      <div className="iron-usage-bars">
        {BAR_WINDOWS.map((w) => {
          const count = report.windows[w].requests;
          const pct = Math.round((Math.min(count, scale) / scale) * 100);
          const label = interpolate(labels.usageRequests, {
            count: String(count),
            window: windowLabel(w),
          });
          return (
            <div className="iron-usage-bar-row" key={w}>
              <span className="iron-usage-window">{windowLabel(w)}</span>
              <div
                className="iron-usage-bar"
                role="meter"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={scale}
                aria-valuenow={count}
                data-testid={`usage-bar-${report.profileId}-${w}`}
              >
                <span style={{ width: `${pct}%` }} />
              </div>
              <span className="iron-usage-count">{formatCount(count)}</span>
            </div>
          );
        })}
      </div>
      <div className="iron-usage-facts">
        <span>
          {interpolate(labels.usageTokens, {
            input: formatCount(week.inputTokens),
            output: formatCount(week.outputTokens),
          })}
        </span>
        <span>
          {report.parks7d > 0
            ? interpolate(labels.usageParks, { count: String(report.parks7d) })
            : labels.usageNoParks}
        </span>
      </div>
      {est ? (
        <div
          className={`iron-usage-estimate iron-usage-estimate--${est.confidence}`}
          data-testid={`usage-estimate-${report.profileId}`}
        >
          {interpolate(labels.usageEstimate, { minutes: String(est.minutesLeft) })}
          {est.confidence === 'low' ? (
            <span className="iron-usage-rough"> · {labels.usageEstimateRough}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
