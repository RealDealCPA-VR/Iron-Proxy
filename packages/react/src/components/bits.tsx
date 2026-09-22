import { useEffect, useState } from 'react';
import type { LoginCommandInfo, Profile, ProfileState } from '@iron-proxy/core';
import { useSwitcher } from './context.js';
import { useCountdown } from '../hooks/useCountdown.js';
import { copyText, formatLoginCommand, type ClientError } from '../util.js';
import { IconCheck, IconCopy, IconError, IconTerminal } from './icons.jsx';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { labels } = useSwitcher();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="iron-btn iron-btn--sm"
      aria-label={label ?? labels.copy}
      onClick={async () => {
        if (await copyText(text)) setDone(true);
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
      <span>{done ? labels.copied : labels.copy}</span>
    </button>
  );
}

export function CommandBox({ cmd }: { cmd: LoginCommandInfo }) {
  const { labels, onOpenTerminal } = useSwitcher();
  const line = formatLoginCommand(cmd);
  return (
    <div>
      <div className="iron-label">{labels.loginRunThis}</div>
      <div className="iron-code-box">
        <code className="iron-mono" data-testid="login-command">
          {line}
        </code>
        <CopyButton text={line} />
        {onOpenTerminal ? (
          <button
            type="button"
            className="iron-btn iron-btn--sm"
            onClick={() => void onOpenTerminal(cmd)}
          >
            <IconTerminal />
            <span>{labels.loginOpenTerminal}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorBanner({ error, onDismiss }: { error: ClientError; onDismiss?: () => void }) {
  const { labels } = useSwitcher();
  return (
    <div className="iron-banner iron-banner--error" role="alert">
      <IconError />
      <div className="iron-banner-body">
        <strong>{labels.errorPrefix}</strong>
        {error.code ? <span className="iron-banner-code">{error.code}</span> : null}
        <div>{error.message}</div>
      </div>
      {onDismiss ? (
        <button type="button" className="iron-btn iron-btn--ghost iron-btn--sm" onClick={onDismiss}>
          {labels.dismiss}
        </button>
      ) : null}
    </div>
  );
}

export type PillKind = 'active' | 'ready' | 'parked' | 'login' | 'off' | 'checking' | 'signing';

export function statusKind(
  profile: Profile,
  state: ProfileState | undefined,
  signingIn: boolean,
): PillKind {
  if (!profile.enabled) return 'off';
  if (signingIn) return 'signing';
  switch (state?.status) {
    case 'active':
      return 'active';
    case 'ready':
      return 'ready';
    case 'parked':
      return 'parked';
    case 'unauthenticated':
      return 'login';
    case 'disabled':
      return 'off';
    default:
      return 'checking';
  }
}

export function StatusPill({
  profile,
  state,
  signingIn,
}: {
  profile: Profile;
  state: ProfileState | undefined;
  signingIn: boolean;
}) {
  const { labels } = useSwitcher();
  const kind = statusKind(profile, state, signingIn);
  const countdown = useCountdown(kind === 'parked' ? state?.parkedUntil : undefined);
  const text = (() => {
    switch (kind) {
      case 'active':
        return labels.statusActive;
      case 'ready':
        return labels.statusReady;
      case 'parked':
        return countdown.active
          ? `${labels.statusParked} · ${labels.statusResetsIn} ${countdown.label}`
          : labels.statusParked;
      case 'login':
        return labels.statusNeedsLogin;
      case 'off':
        return labels.statusOff;
      case 'signing':
        return labels.statusSigningIn;
      default:
        return labels.statusChecking;
    }
  })();
  const cls =
    kind === 'active'
      ? 'iron-pill iron-pill--active'
      : kind === 'ready'
        ? 'iron-pill iron-pill--ready'
        : kind === 'parked'
          ? 'iron-pill iron-pill--parked'
          : kind === 'login'
            ? 'iron-pill iron-pill--login'
            : kind === 'signing' || kind === 'checking'
              ? 'iron-pill iron-pill--busy'
              : 'iron-pill';
  const title =
    kind === 'parked' && state?.parkedReason?.message ? state.parkedReason.message : undefined;
  return (
    <span className={cls} data-status={kind} {...(title ? { title } : {})}>
      {text}
    </span>
  );
}

export function UsageBar({ state }: { state: ProfileState | undefined }) {
  const { labels } = useSwitcher();
  const u = state?.usage?.utilisation;
  if (u === undefined) return null;
  const pct = Math.round(Math.min(1, Math.max(0, u)) * 100);
  const cls =
    pct >= 95
      ? 'iron-usage-bar iron-usage-bar--full'
      : pct >= 75
        ? 'iron-usage-bar iron-usage-bar--high'
        : 'iron-usage-bar';
  return (
    <div className="iron-usage" aria-label={`${labels.usage} ${pct}%`}>
      <div
        className={cls}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <span>{pct}%</span>
    </div>
  );
}
