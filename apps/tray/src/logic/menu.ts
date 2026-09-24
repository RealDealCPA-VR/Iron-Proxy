import type { Profile, ProfileState, ProviderId } from '@iron-proxy/core';
import { DEFAULT_PROVIDER_NAMES, formatClockTime, safeTitle } from '@iron-proxy/electron';
import type { ElectronMenuItemOptions } from '../electron-like.js';
import type { TraySettings } from './settings.js';
import {
  baseUrls,
  NOTIFICATION_KIND_LABELS,
  TRAY_NOTIFICATION_KINDS,
  type TrayNotificationKind,
} from './shared.js';

export { NOTIFICATION_KIND_LABELS } from './shared.js';

/**
 * The tray menu and tooltip as pure functions of the current state, so every
 * label, check mark and action is testable without Electron. `main.ts` turns
 * the actions into click handlers.
 */

export type TrayAction =
  | { type: 'activate'; profileId: string }
  | { type: 'open-window' }
  | { type: 'copy'; text: string }
  | { type: 'toggle-notifications' }
  | { type: 'toggle-notification-kind'; kind: TrayNotificationKind }
  | { type: 'toggle-start-at-login' }
  | { type: 'quit' };

/** A serialisable subset of Electron's MenuItemConstructorOptions, plus the action a click runs. */
export interface MenuTemplateItem {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
  checked?: boolean;
  enabled?: boolean;
  submenu?: MenuTemplateItem[];
  action?: TrayAction;
}

export interface TrayProviderInfo {
  id: ProviderId;
}

export interface TrayMenuModel {
  /** Section order. Providers with no accounts get no section. */
  providers: readonly TrayProviderInfo[];
  profiles: readonly Profile[];
  states: Readonly<Record<string, ProfileState>>;
  /** The account that serves each provider's next request (see `activeAccounts`). */
  activeByProvider: Partial<Record<ProviderId, string>>;
  /** The local proxy, when one is running. */
  proxyUrl?: string;
  settings: TraySettings;
  /** Milliseconds since the epoch, for "parked until" times. */
  now: number;
  locale?: string;
  timeZone?: string;
  /** Windows and Linux read `&` as a mnemonic marker, so labels escape it there. */
  platform?: NodeJS.Platform;
}

export function providerName(id: ProviderId): string {
  return DEFAULT_PROVIDER_NAMES[id] ?? id;
}

/** Parked with a reset still in the future (or no reset time at all). */
function isResting(st: ProfileState | undefined, now: number): boolean {
  if (st?.status !== 'parked') return false;
  if (!st.parkedUntil) return true;
  const at = new Date(st.parkedUntil).getTime();
  return !Number.isFinite(at) || at > now;
}

/**
 * Per provider, the account the router tries first for the next request: the
 * lowest `order` among enabled accounts that are signed in and not resting.
 * This is what "Use this" (activate) changes, so the menu's radio follows the
 * user's click at once, before any request has run.
 */
export function activeAccounts(
  profiles: readonly Profile[],
  states: Readonly<Record<string, ProfileState>>,
  now: number,
): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  const sorted = [...profiles].sort((a, b) => a.order - b.order);
  for (const p of sorted) {
    if (out[p.provider] !== undefined || !p.enabled) continue;
    const st = states[p.id];
    if (st?.status === 'unauthenticated' || st?.status === 'disabled') continue;
    if (isResting(st, now)) continue;
    out[p.provider] = p.id;
  }
  return out;
}

/** "parked until 3:40 PM", "needs login", "off", or nothing. */
export function statusSuffix(
  p: Profile,
  st: ProfileState | undefined,
  now: number,
  locale?: string,
  timeZone?: string,
): string | undefined {
  if (!p.enabled || st?.status === 'disabled') return 'off';
  if (st?.status === 'unauthenticated') return 'needs login';
  if (isResting(st, now)) {
    const at = st?.parkedUntil ? formatClockTime(st.parkedUntil, now, locale, timeZone) : undefined;
    return at ? `parked until ${at}` : 'parked';
  }
  return undefined;
}

function displayTitle(p: Profile): string {
  return safeTitle(p.title) ?? `${providerName(p.provider)} account`;
}

function escapeLabel(label: string, platform: NodeJS.Platform | undefined): string {
  return platform === 'darwin' ? label : label.replace(/&/g, '&&');
}

function sectionOrder(
  providers: readonly TrayProviderInfo[],
  profiles: readonly Profile[],
): ProviderId[] {
  const withAccounts = new Set(profiles.map((p) => p.provider));
  const ordered = providers.map((p) => p.id).filter((id) => withAccounts.has(id));
  for (const p of profiles) if (!ordered.includes(p.provider)) ordered.push(p.provider);
  return ordered;
}

export function buildTrayMenu(model: TrayMenuModel): MenuTemplateItem[] {
  const esc = (s: string) => escapeLabel(s, model.platform);
  const items: MenuTemplateItem[] = [];

  if (!model.profiles.length) {
    items.push({ id: 'add-account', label: 'Add an account…', action: { type: 'open-window' } });
  } else {
    for (const provider of sectionOrder(model.providers, model.profiles)) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ id: `provider-${provider}`, label: providerName(provider), enabled: false });
      const accounts = model.profiles
        .filter((p) => p.provider === provider)
        .sort((a, b) => a.order - b.order);
      for (const p of accounts) {
        const suffix = statusSuffix(p, model.states[p.id], model.now, model.locale, model.timeZone);
        const label = `${displayTitle(p)}${suffix ? ` (${suffix})` : ''}`;
        items.push({
          id: `account-${p.id}`,
          label: esc(label),
          type: 'radio',
          checked: model.activeByProvider[provider] === p.id,
          enabled: p.enabled,
          ...(p.enabled ? { action: { type: 'activate', profileId: p.id } as const } : {}),
        });
      }
    }
  }

  items.push({ type: 'separator' });
  items.push({ id: 'open', label: 'Open Iron-Proxy…', action: { type: 'open-window' } });
  if (model.proxyUrl) {
    const urls = baseUrls(model.proxyUrl);
    items.push({ id: 'proxy-url', label: esc(`Proxy: ${model.proxyUrl}`), enabled: false });
    items.push({
      id: 'copy-openai',
      label: 'Copy OpenAI base URL',
      action: { type: 'copy', text: urls.openai },
    });
    items.push({
      id: 'copy-anthropic',
      label: 'Copy Anthropic base URL',
      action: { type: 'copy', text: urls.anthropic },
    });
  } else {
    items.push({ id: 'proxy-url', label: 'Proxy is not running', enabled: false });
    items.push({ id: 'copy-openai', label: 'Copy OpenAI base URL', enabled: false });
    items.push({ id: 'copy-anthropic', label: 'Copy Anthropic base URL', enabled: false });
  }

  items.push({ type: 'separator' });
  const n = model.settings.notifications;
  items.push({
    id: 'notifications',
    label: 'Notifications',
    type: 'submenu',
    submenu: [
      {
        id: 'notifications-enabled',
        label: 'Show notifications',
        type: 'checkbox',
        checked: n.enabled,
        action: { type: 'toggle-notifications' },
      },
      { type: 'separator' },
      ...TRAY_NOTIFICATION_KINDS.map((kind): MenuTemplateItem => ({
        id: `notify-${kind}`,
        label: NOTIFICATION_KIND_LABELS[kind],
        type: 'checkbox',
        checked: n.kinds[kind],
        enabled: n.enabled,
        action: { type: 'toggle-notification-kind', kind },
      })),
    ],
  });
  items.push({
    id: 'start-at-login',
    label: 'Start at login',
    type: 'checkbox',
    checked: model.settings.startAtLogin,
    action: { type: 'toggle-start-at-login' },
  });
  items.push({ type: 'separator' });
  items.push({ id: 'quit', label: 'Quit Iron-Proxy', action: { type: 'quit' } });
  return items;
}

/** Windows caps tray tooltips at 127 characters. */
export const MAX_TOOLTIP = 127;

/** `Iron-Proxy: Claude on "Work Claude Max", ChatGPT on "Personal Plus"`. */
export function trayTooltip(
  model: Pick<TrayMenuModel, 'providers' | 'profiles' | 'activeByProvider' | 'proxyUrl'>,
): string {
  let text: string;
  if (!model.profiles.length) {
    text = 'Iron-Proxy: no accounts yet';
  } else {
    const parts = sectionOrder(model.providers, model.profiles).map((provider) => {
      const id = model.activeByProvider[provider];
      const p = id === undefined ? undefined : model.profiles.find((x) => x.id === id);
      return p
        ? `${providerName(provider)} on "${displayTitle(p)}"`
        : `${providerName(provider)}: no account ready`;
    });
    text = `Iron-Proxy: ${parts.join(', ')}`;
  }
  if (!model.proxyUrl) text += ' (proxy not running)';
  return text.length > MAX_TOOLTIP ? `${text.slice(0, MAX_TOOLTIP - 1)}…` : text;
}

/** Menu template items to Electron's options, with each action wired to `dispatch`. */
export function toElectronTemplate(
  items: readonly MenuTemplateItem[],
  dispatch: (action: TrayAction) => void,
): ElectronMenuItemOptions[] {
  return items.map((item) => {
    const { action, submenu, ...rest } = item;
    return {
      ...rest,
      ...(submenu ? { submenu: toElectronTemplate(submenu, dispatch) } : {}),
      ...(action ? { click: () => dispatch(action) } : {}),
    };
  });
}
