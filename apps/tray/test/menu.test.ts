import { describe, expect, it } from 'vitest';
import type { Profile, ProfileState } from '@iron-proxy/core';
import {
  activeAccounts,
  buildTrayMenu,
  MAX_TOOLTIP,
  statusSuffix,
  toElectronTemplate,
  trayTooltip,
  type MenuTemplateItem,
  type TrayAction,
  type TrayMenuModel,
} from '../src/logic/menu.js';
import { defaultSettings } from '../src/logic/settings.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function profile(p: Partial<Profile> & Pick<Profile, 'id' | 'title' | 'provider'>): Profile {
  return {
    lane: 'cli',
    order: 0,
    enabled: true,
    createdAt: 'x',
    updatedAt: 'x',
    ...p,
  };
}

function state(profileId: string, s: Partial<ProfileState> = {}): ProfileState {
  return { profileId, status: 'ready', served: 0, ...s };
}

function model(over: Partial<TrayMenuModel> = {}): TrayMenuModel {
  const profiles = over.profiles ?? [];
  const states = over.states ?? {};
  return {
    providers: [{ id: 'anthropic' }, { id: 'openai' }, { id: 'google' }],
    profiles,
    states,
    activeByProvider: activeAccounts(profiles, states, NOW),
    proxyUrl: 'http://127.0.0.1:8791',
    settings: defaultSettings(),
    now: NOW,
    locale: 'en-US',
    timeZone: 'UTC',
    platform: 'win32',
    ...over,
  };
}

const byId = (items: MenuTemplateItem[], id: string): MenuTemplateItem | undefined => {
  for (const i of items) {
    if (i.id === id) return i;
    const inner = i.submenu ? byId(i.submenu, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
};

const twoClaudes = [
  profile({ id: 'w', title: 'Work Claude Max', provider: 'anthropic', order: 0 }),
  profile({ id: 'h', title: 'Home Claude', provider: 'anthropic', order: 1 }),
  profile({ id: 'c', title: 'ChatGPT Plus', provider: 'openai', order: 0 }),
];

describe('buildTrayMenu', () => {
  it('lists one section per provider with a radio on the account that serves next', () => {
    const states = { w: state('w'), h: state('h'), c: state('c') };
    const items = buildTrayMenu(model({ profiles: twoClaudes, states }));

    expect(items.slice(0, 7).map((i) => i.label ?? `(${i.type})`)).toEqual([
      'Claude',
      'Work Claude Max',
      'Home Claude',
      '(separator)',
      'ChatGPT',
      'ChatGPT Plus',
      '(separator)',
    ]);
    expect(byId(items, 'provider-anthropic')?.enabled).toBe(false);
    const work = byId(items, 'account-w')!;
    expect(work).toMatchObject({ type: 'radio', checked: true, enabled: true });
    expect(work.action).toEqual({ type: 'activate', profileId: 'w' });
    expect(byId(items, 'account-h')).toMatchObject({ type: 'radio', checked: false });
    expect(byId(items, 'account-h')?.action).toEqual({ type: 'activate', profileId: 'h' });
    expect(byId(items, 'account-c')?.checked).toBe(true);
    // No section for a provider without accounts.
    expect(byId(items, 'provider-google')).toBeUndefined();
  });

  it('moves the radio when the first account rests and shows the local reset time', () => {
    const states = {
      w: state('w', {
        status: 'parked',
        parkedUntil: '2026-09-24T15:40:00Z',
        parkedReason: { kind: 'quota-exhausted', source: 'cli-output' },
      }),
      h: state('h'),
      c: state('c'),
    };
    const items = buildTrayMenu(model({ profiles: twoClaudes, states }));
    expect(byId(items, 'account-w')?.label).toBe('Work Claude Max (parked until 3:40 PM)');
    expect(byId(items, 'account-w')?.checked).toBe(false);
    expect(byId(items, 'account-h')?.checked).toBe(true);

    // The same instant in another time zone reads as that zone's clock.
    const ny = buildTrayMenu(model({ profiles: twoClaudes, states, timeZone: 'America/New_York' }));
    expect(byId(ny, 'account-w')?.label).toBe('Work Claude Max (parked until 11:40 AM)');

    // A rest that is already over is not a rest.
    const later = NOW + 5 * 3_600_000;
    const after = buildTrayMenu(
      model({
        profiles: twoClaudes,
        states,
        now: later,
        activeByProvider: activeAccounts(twoClaudes, states, later),
      }),
    );
    expect(byId(after, 'account-w')?.label).toBe('Work Claude Max');
    expect(byId(after, 'account-w')?.checked).toBe(true);
  });

  it('marks accounts that need a login, are switched off, or rest without a time', () => {
    const profiles = [
      profile({ id: 'a', title: 'Needs Login', provider: 'anthropic', order: 0 }),
      profile({ id: 'b', title: 'Switched Off', provider: 'anthropic', order: 1, enabled: false }),
      profile({ id: 'd', title: 'Resting', provider: 'anthropic', order: 2 }),
      profile({ id: 'e', title: 'Ready', provider: 'anthropic', order: 3 }),
    ];
    const states = {
      a: state('a', { status: 'unauthenticated' }),
      b: state('b'),
      d: state('d', { status: 'parked' }),
      e: state('e'),
    };
    const items = buildTrayMenu(model({ profiles, states }));
    expect(byId(items, 'account-a')?.label).toBe('Needs Login (needs login)');
    expect(byId(items, 'account-a')?.checked).toBe(false);
    expect(byId(items, 'account-b')).toMatchObject({ label: 'Switched Off (off)', enabled: false });
    expect(byId(items, 'account-b')?.action).toBeUndefined();
    expect(byId(items, 'account-d')?.label).toBe('Resting (parked)');
    expect(byId(items, 'account-e')?.checked).toBe(true);
  });

  it('offers "Add an account…" that opens the window when there are no accounts', () => {
    const items = buildTrayMenu(model());
    expect(items[0]).toEqual({
      id: 'add-account',
      label: 'Add an account…',
      action: { type: 'open-window' },
    });
    expect(items.some((i) => i.type === 'radio')).toBe(false);
  });

  it('has open, copy base URLs, notifications, start at login and quit', () => {
    const items = buildTrayMenu(model({ profiles: twoClaudes, states: {} }));
    expect(byId(items, 'open')?.action).toEqual({ type: 'open-window' });
    expect(byId(items, 'copy-openai')?.action).toEqual({
      type: 'copy',
      text: 'http://127.0.0.1:8791/v1',
    });
    expect(byId(items, 'copy-anthropic')?.action).toEqual({
      type: 'copy',
      text: 'http://127.0.0.1:8791',
    });
    const notifications = byId(items, 'notifications')!;
    expect(notifications.type).toBe('submenu');
    expect(notifications.submenu?.filter((i) => i.type === 'checkbox').map((i) => i.id)).toEqual([
      'notifications-enabled',
      'notify-switched',
      'notify-parked',
      'notify-exhausted',
      'notify-login',
    ]);
    expect(byId(items, 'start-at-login')).toMatchObject({ type: 'checkbox', checked: false });
    expect(items.at(-1)).toMatchObject({ id: 'quit', action: { type: 'quit' } });
  });

  it('reflects the settings in the check marks and greys kinds out when notifications are off', () => {
    const settings = defaultSettings();
    settings.notifications.enabled = false;
    settings.notifications.kinds.parked = false;
    settings.startAtLogin = true;
    const items = buildTrayMenu(model({ settings }));
    expect(byId(items, 'notifications-enabled')?.checked).toBe(false);
    expect(byId(items, 'notify-parked')).toMatchObject({ checked: false, enabled: false });
    expect(byId(items, 'notify-switched')).toMatchObject({ checked: true, enabled: false });
    expect(byId(items, 'start-at-login')?.checked).toBe(true);
  });

  it('disables the copy items when no proxy is running', () => {
    const { proxyUrl: _gone, ...rest } = model();
    const items = buildTrayMenu(rest);
    expect(byId(items, 'proxy-url')?.label).toBe('Proxy is not running');
    expect(byId(items, 'copy-openai')).toMatchObject({ enabled: false });
    expect(byId(items, 'copy-openai')?.action).toBeUndefined();
  });

  it('never shows an email address and escapes & outside macOS', () => {
    const profiles = [
      profile({ id: 'x', title: 'me@example.com Max', provider: 'anthropic' }),
      profile({ id: 'y', title: 'R&D Claude', provider: 'anthropic', order: 1 }),
    ];
    const win = buildTrayMenu(model({ profiles, states: {} }));
    expect(JSON.stringify(win)).not.toContain('example.com');
    expect(byId(win, 'account-x')?.label).toBe('(account) Max');
    expect(byId(win, 'account-y')?.label).toBe('R&&D Claude');
    const mac = buildTrayMenu(model({ profiles, states: {}, platform: 'darwin' }));
    expect(byId(mac, 'account-y')?.label).toBe('R&D Claude');
  });
});

describe('statusSuffix', () => {
  it('says the weekday for a reset more than 20 hours away', () => {
    const p = profile({ id: 'w', title: 'W', provider: 'anthropic' });
    const st = state('w', { status: 'parked', parkedUntil: '2026-09-26T09:05:00Z' });
    expect(statusSuffix(p, st, NOW, 'en-US', 'UTC')).toBe('parked until Sat 9:05 AM');
  });
});

describe('trayTooltip', () => {
  it('names the account serving each provider', () => {
    const states = { w: state('w'), h: state('h'), c: state('c') };
    expect(trayTooltip(model({ profiles: twoClaudes, states }))).toBe(
      'Iron-Proxy: Claude on "Work Claude Max", ChatGPT on "ChatGPT Plus"',
    );
  });

  it('says when no account is ready, when there are none, and when the proxy is down', () => {
    const states = {
      w: state('w', { status: 'parked' }),
      h: state('h', { status: 'unauthenticated' }),
    };
    const profiles = twoClaudes.slice(0, 2);
    expect(trayTooltip(model({ profiles, states }))).toBe('Iron-Proxy: Claude: no account ready');
    expect(trayTooltip(model())).toBe('Iron-Proxy: no accounts yet');
    const { proxyUrl: _gone, ...rest } = model();
    expect(trayTooltip(rest)).toBe('Iron-Proxy: no accounts yet (proxy not running)');
  });

  it('stays within the Windows tooltip limit', () => {
    const profiles = (['anthropic', 'openai', 'google', 'xai'] as const).map((provider, i) =>
      profile({ id: `p${i}`, title: `A very long account title number ${i}`, provider }),
    );
    const text = trayTooltip(model({ profiles, states: {} }));
    expect(text.length).toBeLessThanOrEqual(MAX_TOOLTIP);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('toElectronTemplate', () => {
  it('turns actions into click handlers, recursively, and drops the action field', () => {
    const seen: TrayAction[] = [];
    const items = buildTrayMenu(model({ profiles: twoClaudes, states: {} }));
    const tpl = toElectronTemplate(items, (a) => seen.push(a));
    expect(JSON.stringify(tpl)).not.toContain('"action"');
    const find = (id: string) => {
      const walk = (xs: typeof tpl): (typeof tpl)[number] | undefined => {
        for (const x of xs) {
          if (x.id === id) return x;
          const inner = x.submenu ? walk(x.submenu) : undefined;
          if (inner) return inner;
        }
        return undefined;
      };
      return walk(tpl);
    };
    find('account-h')?.click?.();
    find('notify-login')?.click?.();
    expect(find('provider-anthropic')?.click).toBeUndefined();
    expect(seen).toEqual([
      { type: 'activate', profileId: 'h' },
      { type: 'toggle-notification-kind', kind: 'login' },
    ]);
  });
});
