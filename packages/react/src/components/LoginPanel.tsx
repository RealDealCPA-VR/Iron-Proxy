import { useState } from 'react';
import type { LoginCommandInfo } from '@iron-proxy/core';
import { useSwitcher } from './context.js';
import { CommandBox, CopyButton } from './bits.jsx';
import { IconCheck, IconLink, IconTerminal, IconWarn } from './icons.jsx';

export interface LoginPanelProps {
  profileId: string;
  /** Called when the user closes a finished panel. */
  onClose?: () => void;
}

/** Progress of a click-and-continue login: link, code, output, terminal fallback. */
export function LoginPanel({ profileId, onClose }: LoginPanelProps) {
  const { labels, view } = useSwitcher();
  const progress = view.loginProgress[profileId] ?? {
    urls: [],
    codes: [],
    lines: [],
    status: 'idle' as const,
  };
  const [cmd, setCmd] = useState<LoginCommandInfo | undefined>();
  const [loadingCmd, setLoadingCmd] = useState(false);

  const showTerminal = async () => {
    setLoadingCmd(true);
    const c = await view.actions.loginCommand(profileId);
    setLoadingCmd(false);
    if (c) setCmd(c);
  };

  return (
    <div className="iron-login" data-testid="login-panel" data-login-status={progress.status}>
      {progress.status === 'running' ? (
        <div className="iron-login-status" role="status">
          <span className="iron-spinner" aria-hidden />
          <span>{labels.loginWaiting}</span>
        </div>
      ) : null}
      {progress.status === 'done' ? (
        <div className="iron-banner iron-banner--ok" role="status">
          <IconCheck />
          <div className="iron-banner-body">{labels.loginDone}</div>
          {onClose ? (
            <button
              type="button"
              className="iron-btn iron-btn--ghost iron-btn--sm"
              onClick={onClose}
            >
              {labels.dismiss}
            </button>
          ) : null}
        </div>
      ) : null}
      {progress.status === 'failed' ? (
        <div className="iron-banner iron-banner--warn" role="alert">
          <IconWarn />
          <div className="iron-banner-body">
            <strong>{labels.loginFailed}</strong>
            {progress.message ? <div>{progress.message}</div> : null}
          </div>
          <button
            type="button"
            className="iron-btn iron-btn--sm"
            onClick={() => void view.actions.login(profileId)}
          >
            {labels.loginRetry}
          </button>
        </div>
      ) : null}

      {progress.urls.length ? (
        <div>
          <div className="iron-label">{labels.loginOpenUrl}</div>
          {progress.urls.map((u) => (
            <div key={u} className="iron-code-box">
              <IconLink />
              <a
                className="iron-mono"
                href={u}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="login-url"
              >
                {u}
              </a>
              <CopyButton text={u} />
            </div>
          ))}
        </div>
      ) : null}
      {progress.codes.length ? (
        <div>
          <div className="iron-label">{labels.loginCode}</div>
          {progress.codes.map((c) => (
            <div key={c} className="iron-code-box">
              <span className="iron-login-code" data-testid="login-code">
                {c}
              </span>
              <CopyButton text={c} />
            </div>
          ))}
        </div>
      ) : null}

      {progress.lines.length ? (
        <details>
          <summary>{labels.loginOutput}</summary>
          <pre className="iron-login-output">{progress.lines.join('\n')}</pre>
        </details>
      ) : null}

      {cmd ? <CommandBox cmd={cmd} /> : null}

      <div className="iron-panel-actions">
        {!cmd ? (
          <button
            type="button"
            className="iron-btn iron-btn--sm"
            onClick={() => void showTerminal()}
            disabled={loadingCmd}
          >
            <IconTerminal />
            <span>{labels.loginOpenTerminal}</span>
          </button>
        ) : null}
        {progress.status === 'running' ? (
          <button
            type="button"
            className="iron-btn iron-btn--sm"
            onClick={() => void view.actions.cancelLogin(profileId)}
          >
            {labels.cancel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
