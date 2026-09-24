import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountSwitcher } from '../src/index.js';
import { FakeIronClient } from './FakeIronClient.js';

function setup(seed?: (c: FakeIronClient) => void) {
  const client = new FakeIronClient();
  seed?.(client);
  const utils = render(<AccountSwitcher client={client} injectStyles={false} />);
  return { client, ...utils };
}

describe('AccountSwitcher', () => {
  it('renders accounts grouped by provider with status pills and injects styles once', async () => {
    const { client } = setup((c) => {
      c.seed({ id: 'a', title: 'Work Claude', provider: 'anthropic' }, { status: 'active' });
      c.seed(
        { id: 'b', title: 'Home Claude', provider: 'anthropic', lane: 'cli' },
        { status: 'unauthenticated' },
      );
      c.seed(
        { id: 'o', title: 'ChatGPT Plus', provider: 'openai', lane: 'cli' },
        { status: 'ready' },
      );
    });
    await screen.findByText('Work Claude');
    const anth = screen.getByTestId('group-anthropic');
    expect(within(anth).getAllByTestId(/^row-/)).toHaveLength(2);
    expect(within(screen.getByTestId('row-a')).getByText('Active')).toBeTruthy();
    expect(within(screen.getByTestId('row-b')).getByText('Needs login')).toBeTruthy();
    expect(within(screen.getByTestId('row-o')).getByText('Ready')).toBeTruthy();
    expect(within(screen.getByTestId('row-b')).getByText('Subscription')).toBeTruthy();
    expect(document.getElementById('iron-proxy-switcher-styles')).toBeNull();
    void client;
  });

  it('renames inline through updateProfile', async () => {
    const { client } = setup((c) =>
      c.seed({ id: 'a', title: 'Work Claude', provider: 'anthropic' }),
    );
    fireEvent.click(await screen.findByText('Work Claude'));
    const input = screen.getByLabelText('Rename') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Main Claude' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText('Main Claude');
    expect(client.calls).toContain('updateProfile:a:{"title":"Main Claude"}');
  });

  it('"Use this" activates and the row becomes Active on the switched event', async () => {
    const { client } = setup((c) => {
      c.seed({ id: 'a', title: 'First', provider: 'anthropic' }, { status: 'active' });
      c.seed({ id: 'b', title: 'Second', provider: 'anthropic' }, { status: 'ready' });
    });
    await screen.findByText('Second');
    const rowB = screen.getByTestId('row-b');
    fireEvent.click(within(rowB).getByText('Use this'));
    await waitFor(() => expect(client.calls).toContain('activate:b'));
    await waitFor(() =>
      expect(within(screen.getByTestId('row-b')).getByText('Active')).toBeTruthy(),
    );
    expect(within(screen.getByTestId('row-a')).getByText('Ready')).toBeTruthy();
    // b is now first in its group
    const rows = within(screen.getByTestId('group-anthropic')).getAllByTestId(/^row-/);
    expect(rows[0]?.getAttribute('data-profile-id')).toBe('b');
  });

  it('shows a parked countdown and "Try again now" unparks', async () => {
    const until = new Date(Date.now() + 12 * 60_000 + 34_000).toISOString();
    const { client } = setup((c) =>
      c.seed(
        { id: 'a', title: 'Parked one', provider: 'anthropic' },
        {
          status: 'parked',
          parkedUntil: until,
          parkedReason: { kind: 'rate-limit', source: 'status', message: 'limited' },
        },
      ),
    );
    await screen.findByText('Parked one');
    const pill = screen.getByText(/Parked · resets in/);
    expect(pill.textContent).toMatch(/resets in 12:3\d/);
    fireEvent.click(screen.getByLabelText('More actions: Parked one'));
    fireEvent.click(screen.getByText('Try again now'));
    await waitFor(() => expect(client.calls).toContain('unpark:a'));
    await screen.findByText('Ready');
  });

  it('adds an API-key account and never shows the key afterwards', async () => {
    const { client } = setup();
    fireEvent.click(await screen.findByText('Add account'));
    fireEvent.click(await screen.findByText('Anthropic (Claude)'));
    fireEvent.click(screen.getByText('API key'));
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(title.value).toBe('Personal Claude');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-secret-123' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() =>
      expect(
        client.calls.some((c) => c.startsWith('createProfile:Personal Claude:api-key:withKey')),
      ).toBe(true),
    );
    await screen.findByTestId(/^row-/);
    expect(document.body.textContent).not.toContain('sk-secret-123');
    expect(screen.queryByTestId('add-account')).toBeNull();
  });

  it('adds a subscription account, shows the login URL and code, then "Signed in"', async () => {
    const { client } = setup();
    fireEvent.click(await screen.findByText('Add account'));
    fireEvent.click(await screen.findByText('OpenAI (ChatGPT / Codex)'));
    fireEvent.click(screen.getByText('Subscription'));
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => expect(client.calls.some((c) => c.startsWith('login:'))).toBe(true));
    const id = client.calls.find((c) => c.startsWith('login:'))!.slice('login:'.length);
    act(() => client.loginProgress(id, 'https://example.test/device', 'WXYZ-9876'));
    expect((await screen.findByTestId('login-url')).getAttribute('href')).toBe(
      'https://example.test/device',
    );
    expect((await screen.findByTestId('login-code')).textContent).toBe('WXYZ-9876');
    act(() => client.pendingLogins.get(id)!.resolve());
    await screen.findByText('Signed in');
  });

  it('shows the exhausted banner and dismisses it', async () => {
    const { client } = setup((c) => c.seed({ id: 'a', title: 'Only', provider: 'anthropic' }));
    await screen.findByText('Only');
    act(() =>
      client.emit({
        type: 'provider.exhausted',
        provider: 'anthropic',
        earliestResetAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    const banner = await screen.findByTestId('exhausted-anthropic');
    expect(banner.textContent).toContain('All Anthropic (Claude) accounts are parked.');
    expect(banner.textContent).toContain('Earliest reset');
    fireEvent.click(within(banner).getByText('Dismiss'));
    await waitFor(() => expect(screen.queryByTestId('exhausted-anthropic')).toBeNull());
  });

  it('keyboard reorder with Alt+ArrowDown and the enable switch', async () => {
    const { client } = setup((c) => {
      c.seed({ id: 'a', title: 'A', provider: 'anthropic' });
      c.seed({ id: 'b', title: 'B', provider: 'anthropic' });
    });
    await screen.findByText('B');
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(client.calls).toContain('reorder:anthropic:b,a'));
    fireEvent.click(screen.getByLabelText('Enabled: B'));
    await waitFor(() => expect(client.calls).toContain('updateProfile:b:{"enabled":false}'));
    await screen.findByText('Off');
  });

  it('offers an existing CLI login and adopts it in one click', async () => {
    const { client } = setup((c) => {
      c.discovered = [
        {
          provider: 'anthropic',
          binary: 'claude',
          home: '/u/.claude',
          installed: true,
          status: 'ok',
          suggestedTitle: 'Claude (existing login)',
        },
        {
          provider: 'openai',
          binary: 'codex',
          home: '/u/.codex',
          installed: true,
          status: 'unauthenticated',
          suggestedTitle: 'Codex (existing login)',
        },
      ];
    });
    fireEvent.click(await screen.findByText('Add account'));
    const found = await screen.findByRole('group', { name: 'Found on this computer' });
    // Only signed-in, not-yet-adopted logins are offered.
    expect(within(found).getAllByRole('listitem')).toHaveLength(1);
    expect(within(found).getByText('/u/.claude')).toBeTruthy();
    fireEvent.click(within(found).getByText('Use this account'));
    await waitFor(() =>
      expect(client.calls).toContain('adoptLogin:anthropic:/u/.claude:Claude (existing login)'),
    );
    await waitFor(() => expect(screen.queryByTestId('add-account')).toBeNull());
    const row = await screen.findByText('Claude (existing login)');
    const id = row.closest('[data-profile-id]')!.getAttribute('data-profile-id')!;
    expect(within(screen.getByTestId(`row-${id}`)).getByText('Existing login')).toBeTruthy();

    // Opening the panel again no longer offers the adopted login.
    fireEvent.click(screen.getByText('Add account'));
    await screen.findByTestId('add-account');
    await waitFor(() => expect(client.calls.filter((c) => c === 'discoverLogins')).toHaveLength(2));
    expect(screen.queryByRole('group', { name: 'Found on this computer' })).toBeNull();
  });

  it('asks before logging out an adopted login, and not for others', async () => {
    const { client } = setup((c) => {
      c.seed({
        id: 'x',
        title: 'Mine',
        provider: 'anthropic',
        lane: 'cli',
        cli: { home: '/u/.claude', adopted: true },
      });
      c.seed({
        id: 'y',
        title: 'Isolated',
        provider: 'anthropic',
        lane: 'cli',
        cli: { home: '/h' },
      });
    });
    await screen.findByText('Mine');
    expect(screen.queryByTestId('adopted-y')).toBeNull();
    fireEvent.click(screen.getByLabelText('More actions: Mine'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Log out' });
    expect(confirm.textContent).toContain('signs that CLI out on this computer too');
    expect(client.calls).not.toContain('logout:x');
    fireEvent.click(within(confirm).getByText('Log out'));
    await waitFor(() => expect(client.calls).toContain('logout:x'));

    fireEvent.click(screen.getByLabelText('More actions: Isolated'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    await waitFor(() => expect(client.calls).toContain('logout:y'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('renders the hint under the error message', async () => {
    const client = new FakeIronClient();
    client.listProfiles = async () => {
      throw Object.assign(new Error('Every anthropic account is parked.'), {
        code: 'ALL_PROFILES_EXHAUSTED',
        hint: 'Wait until 3:40 PM for the first reset, or add another anthropic account.',
      });
    };
    render(<AccountSwitcher client={client} injectStyles={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Every anthropic account is parked.');
    expect(within(alert).getByTestId('error-hint').textContent).toBe(
      'Wait until 3:40 PM for the first reset, or add another anthropic account.',
    );
  });

  it('renders client errors inline', async () => {
    const client = new FakeIronClient();
    client.listProfiles = async () => {
      throw Object.assign(new Error('bridge missing'), { code: 'INVALID_REQUEST' });
    };
    render(<AccountSwitcher client={client} injectStyles={false} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('bridge missing');
    expect(alert.textContent).toContain('INVALID_REQUEST');
    expect(screen.queryByTestId('error-hint')).toBeNull();
  });
});
