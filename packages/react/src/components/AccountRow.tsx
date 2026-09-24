import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LoginCommandInfo, Profile } from '@iron-proxy/core';
import { useSwitcher } from './context.js';
import { CommandBox, StatusPill, UsageBar } from './bits.jsx';
import { LoginPanel } from './LoginPanel.jsx';
import {
  IconDown,
  IconKey,
  IconLogin,
  IconLogout,
  IconMore,
  IconPlay,
  IconTerminal,
  IconTrash,
  IconUp,
} from './icons.jsx';

export interface AccountRowProps {
  profile: Profile;
  index: number;
  count: number;
}

type Detail = 'none' | 'login' | 'terminal' | 'apikey' | 'remove' | 'logout';

export function AccountRow({ profile, index, count }: AccountRowProps) {
  const { labels, view, compact } = useSwitcher();
  const { actions } = view;
  const state = view.states[profile.id];
  const progress = view.loginProgress[profile.id];
  const signingIn = progress?.status === 'running';
  const isActive =
    view.activeByProvider[profile.provider] === profile.id || state?.status === 'active';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [detail, setDetail] = useState<Detail>('none');
  const [cmd, setCmd] = useState<LoginCommandInfo | undefined>();
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const commitTitle = async () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== profile.title) await actions.rename(profile.id, t);
    else setDraft(profile.title);
  };

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey) return;
    if (e.key === 'ArrowUp' && index > 0) {
      e.preventDefault();
      void actions.moveUp(profile.id);
    } else if (e.key === 'ArrowDown' && index < count - 1) {
      e.preventDefault();
      void actions.moveDown(profile.id);
    }
  };

  const laneLabel =
    profile.lane === 'cli'
      ? labels.laneCli
      : profile.lane === 'api-key'
        ? labels.laneApiKey
        : labels.laneOauth;
  const canLogin = profile.lane === 'cli' || profile.lane === 'oauth';
  const parked = state?.status === 'parked';

  const item = (
    key: string,
    icon: JSX.Element,
    text: string,
    onClick: () => void,
    danger = false,
  ) => (
    <li key={key} role="none">
      <button
        type="button"
        role="menuitem"
        className={danger ? 'iron-menu-item iron-menu-item--danger' : 'iron-menu-item'}
        onClick={() => {
          setMenuOpen(false);
          onClick();
        }}
      >
        {icon}
        <span>{text}</span>
      </button>
    </li>
  );

  const rowClass = [
    'iron-row',
    isActive ? 'iron-row--active' : '',
    profile.enabled ? '' : 'iron-row--disabled',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={rowRef}
      className={rowClass}
      data-testid={`row-${profile.id}`}
      data-profile-id={profile.id}
      tabIndex={0}
      onKeyDown={onRowKey}
      aria-label={`${profile.title}, ${laneLabel}`}
    >
      <div className="iron-row-main">
        <div className="iron-row-title-line">
          {editing ? (
            <input
              className="iron-row-title-input"
              aria-label={labels.rename}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitTitle();
                if (e.key === 'Escape') {
                  setDraft(profile.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="iron-row-title"
              title={labels.rename}
              onClick={() => {
                setDraft(profile.title);
                setEditing(true);
              }}
            >
              {profile.title}
            </button>
          )}
          <StatusPill profile={profile} state={state} signingIn={!!signingIn} />
        </div>
        <div className="iron-badges">
          <span className="iron-badge iron-badge--lane">{laneLabel}</span>
          {profile.cli?.adopted ? (
            <span className="iron-badge" data-testid={`adopted-${profile.id}`}>
              {labels.existingLogin}
            </span>
          ) : null}
          {profile.defaultModel && !compact ? (
            <span className="iron-badge">{profile.defaultModel}</span>
          ) : null}
          {index === 0 && count > 1 ? <span className="iron-badge">#1</span> : null}
        </div>
        <UsageBar state={state} />
      </div>

      <div className="iron-row-actions">
        <div className="iron-row-reorder" aria-label="Reorder">
          <button
            type="button"
            className="iron-btn iron-btn--icon"
            aria-label={labels.moveUp}
            disabled={index === 0}
            onClick={() => void actions.moveUp(profile.id)}
          >
            <IconUp />
          </button>
          <button
            type="button"
            className="iron-btn iron-btn--icon"
            aria-label={labels.moveDown}
            disabled={index >= count - 1}
            onClick={() => void actions.moveDown(profile.id)}
          >
            <IconDown />
          </button>
        </div>
        <button
          type="button"
          className={
            isActive && index === 0
              ? 'iron-btn iron-btn--sm iron-btn--ghost'
              : 'iron-btn iron-btn--sm iron-btn--primary'
          }
          disabled={(isActive && index === 0) || !profile.enabled}
          onClick={() => void actions.activate(profile.id)}
        >
          <IconPlay />
          <span>{isActive && index === 0 ? labels.inUse : labels.useThis}</span>
        </button>
        <button
          type="button"
          role="switch"
          className="iron-switch"
          aria-checked={profile.enabled}
          aria-label={`${labels.enabled}: ${profile.title}`}
          onClick={() => void actions.setEnabled(profile.id, !profile.enabled)}
        />
        <div className="iron-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="iron-btn iron-btn--icon"
            aria-label={`${labels.more}: ${profile.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <IconMore />
          </button>
          {menuOpen ? (
            <ul className="iron-menu" role="menu">
              {canLogin
                ? item('login', <IconLogin />, labels.logIn, () => {
                    setDetail('login');
                    void actions.login(profile.id);
                  })
                : null}
              {profile.lane === 'cli'
                ? item('terminal', <IconTerminal />, labels.logInTerminal, async () => {
                    const c = await actions.loginCommand(profile.id);
                    if (c) {
                      setCmd(c);
                      setDetail('terminal');
                    }
                  })
                : null}
              {profile.lane === 'api-key'
                ? item('apikey', <IconKey />, labels.setApiKey, () => {
                    setApiKeySaved(false);
                    setDetail('apikey');
                  })
                : null}
              {parked
                ? item(
                    'unpark',
                    <IconPlay />,
                    labels.tryAgainNow,
                    () => void actions.unpark(profile.id),
                  )
                : null}
              {item('logout', <IconLogout />, labels.logOut, () =>
                // Logging out an adopted login signs the user's own CLI out too: ask first.
                profile.cli?.adopted ? setDetail('logout') : void actions.logout(profile.id),
              )}
              <li className="iron-menu-sep" role="separator" />
              {item('remove', <IconTrash />, labels.remove, () => setDetail('remove'), true)}
            </ul>
          ) : null}
        </div>
      </div>

      {detail === 'login' ? (
        <div className="iron-row-detail">
          <LoginPanel profileId={profile.id} onClose={() => setDetail('none')} />
        </div>
      ) : null}
      {detail === 'terminal' && cmd ? (
        <div className="iron-row-detail">
          <CommandBox cmd={cmd} />
          <div className="iron-panel-actions">
            <button
              type="button"
              className="iron-btn iron-btn--sm"
              onClick={() => setDetail('none')}
            >
              {labels.dismiss}
            </button>
          </div>
        </div>
      ) : null}
      {detail === 'apikey' ? (
        <form
          className="iron-row-detail"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!apiKeyDraft) return;
            await actions.setApiKey(profile.id, apiKeyDraft);
            setApiKeyDraft('');
            setApiKeySaved(true);
          }}
        >
          <label className="iron-label" htmlFor={`iron-key-${profile.id}`}>
            {labels.addApiKeyLabel}
          </label>
          <input
            id={`iron-key-${profile.id}`}
            className="iron-input"
            type="password"
            autoComplete="off"
            value={apiKeyDraft}
            onChange={(e) => setApiKeyDraft(e.target.value)}
          />
          {apiKeySaved ? (
            <div className="iron-help" role="status">
              {labels.apiKeySaved}
            </div>
          ) : null}
          <div className="iron-panel-actions">
            <button
              type="button"
              className="iron-btn iron-btn--sm"
              onClick={() => setDetail('none')}
            >
              {labels.cancel}
            </button>
            <button
              type="submit"
              className="iron-btn iron-btn--sm iron-btn--primary"
              disabled={!apiKeyDraft}
            >
              {labels.save}
            </button>
          </div>
        </form>
      ) : null}
      {detail === 'logout' ? (
        <div className="iron-row-detail" role="alertdialog" aria-label={labels.logOut}>
          <div>{labels.confirmLogoutAdopted}</div>
          <div className="iron-panel-actions">
            <button
              type="button"
              className="iron-btn iron-btn--sm"
              onClick={() => setDetail('none')}
            >
              {labels.cancel}
            </button>
            <button
              type="button"
              className="iron-btn iron-btn--sm iron-btn--danger"
              onClick={() => {
                setDetail('none');
                void actions.logout(profile.id);
              }}
            >
              {labels.logOut}
            </button>
          </div>
        </div>
      ) : null}
      {detail === 'remove' ? (
        <div className="iron-row-detail" role="alertdialog" aria-label={labels.confirmRemove}>
          <div>{labels.confirmRemove}</div>
          <div className="iron-panel-actions">
            <button
              type="button"
              className="iron-btn iron-btn--sm"
              onClick={() => setDetail('none')}
            >
              {labels.cancel}
            </button>
            <button
              type="button"
              className="iron-btn iron-btn--sm iron-btn--danger"
              onClick={() => void actions.remove(profile.id)}
            >
              {labels.remove}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
