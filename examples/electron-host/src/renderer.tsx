import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Profile, StreamEvent } from '@iron-proxy/core';
import { getIronClient } from '@iron-proxy/electron/renderer';
import { AccountSwitcher } from '@iron-proxy/react';

declare global {
  interface Window {
    example: {
      setSelected(id: string | undefined): void;
      chat(prompt: string, provider: string, onEvent: (ev: StreamEvent) => void): Promise<void>;
    };
  }
}

const client = getIronClient();

function ChatBox() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [provider, setProvider] = useState('anthropic');
  const [prompt, setPrompt] = useState('Say hello in five words.');
  const [output, setOutput] = useState('');
  const [servedBy, setServedBy] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client.listProfiles().then(setProfiles);
    return client.onEvent((e) => {
      if (e.type.startsWith('profile.')) void client.listProfiles().then(setProfiles);
    });
  }, []);

  const providers = [...new Set(profiles.filter((p) => p.enabled).map((p) => p.provider))];

  async function send() {
    setBusy(true);
    setOutput('');
    setServedBy('');
    try {
      await window.example.chat(prompt, provider, (ev) => {
        if (ev.type === 'start')
          setServedBy(profiles.find((p) => p.id === ev.profileId)?.title ?? ev.profileId);
        else if (ev.type === 'switched')
          setOutput(
            (o) =>
              o + `\n[switched from ${ev.fromProfileId} to ${ev.toProfileId}: ${ev.reason.kind}]\n`,
          );
        else if (ev.type === 'text') setOutput((o) => o + ev.delta);
        else if (ev.type === 'error')
          setOutput((o) => o + `\n[error ${ev.error.code}] ${ev.error.message}`);
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ margin: 0 }}>Chat</h2>
      <div style={{ display: 'flex', gap: 8 }}>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {(providers.length ? providers : ['anthropic']).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <input
          style={{ flex: 1 }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void send()}
        />
        <button disabled={busy} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      {servedBy && <div style={{ opacity: 0.7 }}>Served by: {servedBy}</div>}
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          minHeight: 80,
          background: 'rgba(127,127,127,.1)',
          padding: 12,
          borderRadius: 8,
        }}
      >
        {output}
      </pre>
    </section>
  );
}

/** Which account the "Open login in terminal" menu item targets. */
function TerminalLoginPicker() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<string>('');
  useEffect(() => {
    void client.listProfiles().then(setProfiles);
    return client.onEvent((e) => {
      if (e.type.startsWith('profile.')) void client.listProfiles().then(setProfiles);
    });
  }, []);
  useEffect(() => window.example.setSelected(selected || undefined), [selected]);
  const cliProfiles = profiles.filter((p) => p.lane === 'cli');
  if (!cliProfiles.length) return null;
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: 0.8 }}>
      Terminal login target (menu: Accounts → Open login in terminal):
      <select value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">— pick an account —</option>
        {cliProfiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title} ({p.provider})
          </option>
        ))}
      </select>
    </label>
  );
}

function App() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: 16,
        display: 'grid',
        gap: 24,
        maxWidth: 960,
        margin: '0 auto',
      }}
    >
      <h1 style={{ margin: 0 }}>Iron-Proxy example host</h1>
      <AccountSwitcher client={client} />
      <TerminalLoginPicker />
      <ChatBox />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
