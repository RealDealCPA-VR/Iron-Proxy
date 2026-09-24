// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoginCommandInfo } from '@iron-proxy/core';
import type { TrayBridge, TrayInfo } from '../src/logic/channels.js';
import {
  applySettingsPatch,
  defaultSettings,
  type TraySettingsPatch,
} from '../src/logic/settings.js';
import { TrayWindow } from '../src/ui/TrayWindow.js';
import { FakeIronClient } from './FakeIronClient.js';

afterEach(() => cleanup());

class FakeTray implements TrayBridge {
  state: TrayInfo = {
    proxyUrl: 'http://127.0.0.1:8791',
    proxyPort: 8791,
    proxyOwned: true,
    settings: defaultSettings(),
    dataDir: '/home/me/.iron-proxy',
  };
  copied: string[] = [];
  terminals: LoginCommandInfo[] = [];
  patches: TraySettingsPatch[] = [];
  listeners = new Set<(i: TrayInfo) => void>();
  async info() {
    return this.state;
  }
  async setSettings(patch: TraySettingsPatch) {
    this.patches.push(patch);
    this.state = { ...this.state, settings: applySettingsPatch(this.state.settings, patch) };
    return this.state;
  }
  async openTerminal(cmd: LoginCommandInfo) {
    this.terminals.push(cmd);
  }
  async copy(text: string) {
    this.copied.push(text);
  }
  onChanged(listener: (i: TrayInfo) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  push(info: TrayInfo) {
    this.state = info;
    for (const l of this.listeners) l(info);
  }
}

function setup(seed?: (c: FakeIronClient) => void) {
  const client = new FakeIronClient();
  seed?.(client);
  const tray = new FakeTray();
  render(<TrayWindow client={client} tray={tray} />);
  return { client, tray };
}

describe('TrayWindow', () => {
  it('shows the proxy URL with copy buttons and the account switcher', async () => {
    const { tray } = setup((c) => {
      c.seed({ id: 'a', title: 'Work Claude Max', provider: 'anthropic' }, { status: 'active' });
    });
    expect(await screen.findByTestId('proxy-url')).toHaveProperty(
      'textContent',
      'http://127.0.0.1:8791',
    );
    await screen.findByText('Work Claude Max');
    fireEvent.click(screen.getByText('Copy OpenAI base URL'));
    fireEvent.click(screen.getByText('Copy Anthropic base URL'));
    await waitFor(() =>
      expect(tray.copied).toEqual(['http://127.0.0.1:8791/v1', 'http://127.0.0.1:8791']),
    );
    await screen.findAllByText('Copied');
  });

  it('says when it is using a proxy started elsewhere, and when none is running', async () => {
    const { tray } = setup();
    await screen.findByTestId('proxy-url');
    act(() => tray.push({ ...tray.state, proxyOwned: false }));
    await screen.findByText(/already running on this computer/);
    const { proxyUrl: _u, proxyPort: _p, ...rest } = tray.state;
    act(() => tray.push(rest));
    await screen.findByText('Proxy is not running');
  });

  it('changes settings through the tray bridge', async () => {
    const { tray } = setup();
    const settings = await screen.findByTestId('settings');
    fireEvent.click(within(settings).getByLabelText('Show notifications'));
    await waitFor(() => expect(tray.patches).toEqual([{ notifications: { enabled: false } }]));
    // With notifications off, the per-kind switches are disabled.
    await waitFor(() =>
      expect(
        (within(settings).getByLabelText('When an account switches') as HTMLInputElement).disabled,
      ).toBe(true),
    );
    fireEvent.click(within(settings).getByLabelText('Start at login'));
    await waitFor(() => expect(tray.patches.at(-1)).toEqual({ startAtLogin: true }));

    const port = within(settings).getByLabelText('Proxy port') as HTMLInputElement;
    const save = within(settings).getByText('Save port') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(port, { target: { value: '99999' } });
    expect(save.disabled).toBe(true);
    screen.getByText('Enter a port from 1 to 65535.');
    fireEvent.change(port, { target: { value: '9900' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(tray.patches.at(-1)).toEqual({ proxyPort: 9900 }));
    await waitFor(() => expect(tray.state.settings.proxyPort).toBe(9900));
  });

  it('sends a terminal login through the bridge and shows its error', async () => {
    const { tray, client } = setup((c) => {
      c.seed(
        { id: 'g', title: 'Terminal Claude', provider: 'anthropic', lane: 'cli' },
        { status: 'unauthenticated' },
      );
    });
    await screen.findByText('Terminal Claude');
    fireEvent.click(screen.getByLabelText('More actions: Terminal Claude'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log in in terminal' }));
    fireEvent.click(await screen.findByText('Open in terminal instead'));
    const expected = await client.loginCommand('g');
    await waitFor(() => expect(tray.terminals).toEqual([expected]));
    expect(screen.queryByRole('alert')).toBeNull();

    tray.openTerminal = async () => {
      throw new Error('That sign-in command does not belong to any account here.');
    };
    fireEvent.click(screen.getByText('Open in terminal instead'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('does not belong');
  });
});
