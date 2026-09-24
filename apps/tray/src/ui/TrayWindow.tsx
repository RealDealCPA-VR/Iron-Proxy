import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { IronClient, LoginCommandInfo } from '@iron-proxy/core';
import { AccountSwitcher } from '@iron-proxy/react';
import type { TrayBridge, TrayInfo } from '../logic/channels.js';
import type { TraySettingsPatch } from '../logic/settings.js';
import {
  baseUrls,
  isValidPort,
  NOTIFICATION_KIND_LABELS,
  TRAY_NOTIFICATION_KINDS,
} from '../logic/shared.js';

export interface TrayWindowProps {
  /** window.ironProxy (the IPC IronClient) in the app; a fake in tests. */
  client: IronClient;
  /** window.ironTray in the app; a fake in tests. */
  tray: TrayBridge;
}

const box: CSSProperties = {
  border: '1px solid rgba(127,127,127,.3)',
  borderRadius: 10,
  padding: 12,
  display: 'grid',
  gap: 8,
};
const row: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' };
const small: CSSProperties = { fontSize: 12, opacity: 0.75 };

function CopyButton({ label, text, tray }: { label: string; text: string; tray: TrayBridge }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={() => void tray.copy(text).then(() => setDone(true))}
      title={text}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function ProxyHeader({ info, tray }: { info: TrayInfo; tray: TrayBridge }) {
  if (!info.proxyUrl) {
    return (
      <header style={box} data-testid="proxy-header">
        <strong>Proxy is not running</strong>
        <span style={small}>
          Another program may be using the port. Pick a different port in Settings below.
        </span>
      </header>
    );
  }
  const urls = baseUrls(info.proxyUrl);
  return (
    <header style={box} data-testid="proxy-header">
      <div style={row}>
        <strong>Local proxy</strong>
        <code data-testid="proxy-url">{info.proxyUrl}</code>
      </div>
      <div style={row}>
        <CopyButton label="Copy OpenAI base URL" text={urls.openai} tray={tray} />
        <CopyButton label="Copy Anthropic base URL" text={urls.anthropic} tray={tray} />
      </div>
      <span style={small}>
        {info.proxyOwned
          ? 'Point any tool at these URLs. Iron-Proxy picks the account.'
          : 'Using the proxy already running on this computer (for example iron-proxy serve).'}
      </span>
    </header>
  );
}

function SettingsPanel({
  info,
  update,
}: {
  info: TrayInfo;
  update: (patch: TraySettingsPatch) => Promise<void>;
}) {
  const s = info.settings;
  const [port, setPort] = useState(String(s.proxyPort));
  useEffect(() => setPort(String(s.proxyPort)), [s.proxyPort]);
  const parsed = Number(port);
  const portOk = isValidPort(parsed);

  return (
    <details style={box} data-testid="settings">
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Settings</summary>
      <label style={row}>
        <input
          type="checkbox"
          checked={s.notifications.enabled}
          onChange={(e) => void update({ notifications: { enabled: e.target.checked } })}
        />
        Show notifications
      </label>
      <div style={{ display: 'grid', gap: 4, paddingLeft: 20 }}>
        {TRAY_NOTIFICATION_KINDS.map((kind) => (
          <label key={kind} style={row}>
            <input
              type="checkbox"
              disabled={!s.notifications.enabled}
              checked={s.notifications.kinds[kind]}
              onChange={(e) =>
                void update({ notifications: { kinds: { [kind]: e.target.checked } } })
              }
            />
            {NOTIFICATION_KIND_LABELS[kind]}
          </label>
        ))}
      </div>
      <label style={row}>
        <input
          type="checkbox"
          checked={s.startAtLogin}
          onChange={(e) => void update({ startAtLogin: e.target.checked })}
        />
        Start at login
      </label>
      <form
        style={row}
        onSubmit={(e) => {
          e.preventDefault();
          if (portOk && parsed !== s.proxyPort) void update({ proxyPort: parsed });
        }}
      >
        <label style={row}>
          Proxy port
          <input
            aria-label="Proxy port"
            inputMode="numeric"
            value={port}
            size={6}
            onChange={(e) => setPort(e.target.value.trim())}
          />
        </label>
        <button type="submit" disabled={!portOk || parsed === s.proxyPort}>
          Save port
        </button>
      </form>
      {!portOk && <span style={small}>Enter a port from 1 to 65535.</span>}
      <span style={small}>
        Accounts are shared with the iron-proxy command line in <code>{info.dataDir}</code>.
      </span>
    </details>
  );
}

/** The tray window: proxy URL header, the account switcher (with its usage panel), settings. */
export function TrayWindow({ client, tray }: TrayWindowProps) {
  const [info, setInfo] = useState<TrayInfo | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let alive = true;
    void tray.info().then((i) => alive && setInfo(i));
    const off = tray.onChanged((i) => setInfo(i));
    return () => {
      alive = false;
      off();
    };
  }, [tray]);

  const update = useCallback(
    async (patch: TraySettingsPatch) => {
      try {
        setInfo(await tray.setSettings(patch));
        setError(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [tray],
  );

  const onOpenTerminal = useCallback(
    async (cmd: LoginCommandInfo) => {
      try {
        await tray.openTerminal(cmd);
        setError(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [tray],
  );

  return (
    <main style={{ padding: 12, display: 'grid', gap: 12 }}>
      {info && <ProxyHeader info={info} tray={tray} />}
      {error && (
        <div role="alert" style={{ ...box, borderColor: 'rgba(220,38,38,.6)' }}>
          {error}
        </div>
      )}
      <AccountSwitcher client={client} compact onOpenTerminal={onOpenTerminal} />
      {info && <SettingsPanel info={info} update={update} />}
    </main>
  );
}
