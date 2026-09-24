import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IronClient, IronEvent, LoginCommandInfo, ProviderId } from '@iron-proxy/core';
import { useIronProxy } from '../hooks/useIronProxy.js';
import { useInjectedStyles } from '../inject-styles.js';
import { defaultLabels, interpolate, type Labels } from '../labels.js';
import { formatClock, groupByProvider, PROVIDER_SHORT } from '../util.js';
import { AccountRow } from './AccountRow.jsx';
import { AddAccount } from './AddAccount.jsx';
import { UsagePanel } from './UsagePanel.jsx';
import { ErrorBanner } from './bits.jsx';
import { SwitcherContext, type SwitcherContextValue } from './context.js';
import { IconChart, IconPlus, IconRefresh, IconWarn } from './icons.jsx';

export interface AccountSwitcherProps {
  /** Any IronClient: window.ironProxy from the Electron preload, HttpIronClient, or LocalIronClient. */
  client: IronClient;
  /** Show only these providers (and offer only them in "Add account"). */
  providers?: ProviderId[];
  /** Tighter rows without model badges and usage bars. */
  compact?: boolean;
  /** Fires with the profile id whenever a request finishes, for hosts that show "served by". */
  onServed?: (profileId: string) => void;
  /** Lets an Electron host open the vendor login in a real terminal window. */
  onOpenTerminal?: (cmd: LoginCommandInfo) => void | Promise<void>;
  /** Override any user-visible string. */
  labels?: Partial<Labels>;
  /** Inject the stylesheet into <head>. Set false when you import `@iron-proxy/react/styles.css` yourself. */
  injectStyles?: boolean;
  /** Force a theme instead of following the OS. */
  theme?: 'light' | 'dark';
  className?: string;
}

/**
 * The drop-in account switcher: accounts grouped by provider, titled, ordered,
 * toggled, logged in, with usage and parked timers. Talks only to `IronClient`.
 */
export function AccountSwitcher({
  client,
  providers,
  compact = false,
  onServed,
  onOpenTerminal,
  labels: labelOverrides,
  injectStyles = true,
  theme,
  className,
}: AccountSwitcherProps) {
  useInjectedStyles(injectStyles);
  const labels = useMemo<Labels>(
    () => ({ ...defaultLabels, ...(labelOverrides ?? {}) }),
    [labelOverrides],
  );
  const onServedRef = useRef(onServed);
  onServedRef.current = onServed;
  const onEvent = useCallback((e: IronEvent) => {
    if (e.type === 'request.finished') onServedRef.current?.(e.profileId);
  }, []);
  const view = useIronProxy(client, { onEvent });
  const [adding, setAdding] = useState(false);
  const [showUsage, setShowUsage] = useState(false);

  const providerName = useCallback(
    (id: ProviderId) =>
      view.providers.find((p) => p.id === id)?.displayName ?? PROVIDER_SHORT[id] ?? id,
    [view.providers],
  );

  const ctx = useMemo<SwitcherContextValue>(
    () => ({ labels, view, providerName, onOpenTerminal, compact }),
    [labels, view, providerName, onOpenTerminal, compact],
  );

  const visible = useMemo(() => {
    const list = providers
      ? view.profiles.filter((p) => providers.includes(p.provider))
      : view.profiles;
    return groupByProvider(list, providers);
  }, [view.profiles, providers]);

  // Close the add panel when the last provider disappears from the allowed set.
  useEffect(() => {
    if (adding && providers && providers.length === 0) setAdding(false);
  }, [adding, providers]);

  const rootClass = ['iron-switcher', compact ? 'iron-switcher--compact' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <SwitcherContext.Provider value={ctx}>
      <div
        className={rootClass}
        {...(theme ? { 'data-theme': theme } : {})}
        data-testid="account-switcher"
      >
        <header className="iron-header">
          <h2>{labels.title}</h2>
          <div className="iron-header-actions">
            <button
              type="button"
              className={`iron-btn iron-btn--sm${showUsage ? ' iron-btn--pressed' : ''}`}
              aria-pressed={showUsage}
              onClick={() => setShowUsage((v) => !v)}
              data-testid="usage-toggle"
            >
              <IconChart />
              <span>{labels.usageShow}</span>
            </button>
            <button
              type="button"
              className="iron-btn iron-btn--icon iron-btn--ghost"
              aria-label={labels.refresh}
              title={labels.refresh}
              disabled={view.loading}
              onClick={() => void view.actions.refresh()}
            >
              <IconRefresh />
            </button>
            <button
              type="button"
              className="iron-btn iron-btn--primary iron-btn--sm"
              onClick={() => setAdding(true)}
              disabled={adding}
              aria-expanded={adding}
            >
              <IconPlus />
              <span>{labels.addAccount}</span>
            </button>
          </div>
        </header>

        {view.error ? <ErrorBanner error={view.error} onDismiss={view.actions.clearError} /> : null}

        {Object.entries(view.exhausted).map(([provider, info]) =>
          info && (!providers || providers.includes(provider as ProviderId)) ? (
            <div
              key={provider}
              className="iron-banner iron-banner--warn"
              role="status"
              data-testid={`exhausted-${provider}`}
            >
              <IconWarn />
              <div className="iron-banner-body">
                <strong>
                  {interpolate(labels.exhausted, {
                    provider: providerName(provider as ProviderId),
                  })}
                </strong>
                {info.earliestResetAt ? (
                  <div>
                    {interpolate(labels.exhaustedReset, {
                      time: formatClock(info.earliestResetAt),
                    })}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className="iron-btn iron-btn--ghost iron-btn--sm"
                onClick={() => view.actions.dismissExhausted(provider as ProviderId)}
              >
                {labels.dismiss}
              </button>
            </div>
          ) : null,
        )}

        {showUsage ? <UsagePanel client={client} {...(providers ? { providers } : {})} /> : null}

        {adding ? <AddAccount onClose={() => setAdding(false)} providers={providers} /> : null}

        {view.loading && !view.profiles.length ? (
          <div className="iron-empty" role="status">
            <span className="iron-spinner" aria-hidden /> {labels.loading}
          </div>
        ) : null}

        {!view.loading && !visible.length && !adding ? (
          <div className="iron-empty">{labels.noAccounts}</div>
        ) : null}

        {visible.map((group) => (
          <section
            key={group.provider}
            className="iron-group"
            aria-label={providerName(group.provider)}
            data-testid={`group-${group.provider}`}
          >
            <div className="iron-group-head">
              <h3>{providerName(group.provider)}</h3>
              <span className="iron-group-count">{group.profiles.length}</span>
            </div>
            {group.profiles.map((p, i) => (
              <AccountRow key={p.id} profile={p} index={i} count={group.profiles.length} />
            ))}
          </section>
        ))}
      </div>
    </SwitcherContext.Provider>
  );
}
