import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NotifierSettings } from '@iron-proxy/electron';
import {
  DEFAULT_PROXY_PORT,
  isValidPort,
  TRAY_NOTIFICATION_KINDS,
  type TrayNotificationKind,
} from './shared.js';

export {
  DEFAULT_PROXY_PORT,
  isValidPort,
  TRAY_NOTIFICATION_KINDS,
  type TrayNotificationKind,
} from './shared.js';

/**
 * The tray app's own settings, kept next to the accounts in
 * `<dataDir>/tray-settings.json`. Nothing secret lives here: switches and a port.
 */

export const SETTINGS_FILE = 'tray-settings.json';

export interface TraySettings {
  notifications: {
    enabled: boolean;
    kinds: Record<TrayNotificationKind, boolean>;
  };
  startAtLogin: boolean;
  /** Preferred port for the local proxy. A free port is used when it is taken. */
  proxyPort: number;
}

export interface TraySettingsPatch {
  notifications?: {
    enabled?: boolean;
    kinds?: Partial<Record<TrayNotificationKind, boolean>>;
  };
  startAtLogin?: boolean;
  proxyPort?: number;
}

export function defaultSettings(): TraySettings {
  return {
    notifications: {
      enabled: true,
      kinds: { switched: true, parked: true, exhausted: true, login: true },
    },
    startAtLogin: false,
    proxyPort: DEFAULT_PROXY_PORT,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Anything (a parsed file, an IPC payload) to complete, valid settings.
 * Unknown or bad fields fall back to the defaults.
 */
export function normalizeSettings(raw: unknown): TraySettings {
  const out = defaultSettings();
  if (!isRecord(raw)) return out;
  const n = raw.notifications;
  if (isRecord(n)) {
    if (typeof n.enabled === 'boolean') out.notifications.enabled = n.enabled;
    if (isRecord(n.kinds)) {
      for (const kind of TRAY_NOTIFICATION_KINDS) {
        const v = n.kinds[kind];
        if (typeof v === 'boolean') out.notifications.kinds[kind] = v;
      }
    }
  }
  if (typeof raw.startAtLogin === 'boolean') out.startAtLogin = raw.startAtLogin;
  if (isValidPort(raw.proxyPort)) out.proxyPort = raw.proxyPort;
  return out;
}

/** Settings with a patch applied. Invalid values in the patch are ignored. */
export function applySettingsPatch(current: TraySettings, patch: unknown): TraySettings {
  const p = isRecord(patch) ? (patch as TraySettingsPatch) : {};
  const n = isRecord(p.notifications) ? p.notifications : {};
  return normalizeSettings({
    notifications: {
      enabled: typeof n.enabled === 'boolean' ? n.enabled : current.notifications.enabled,
      kinds: { ...current.notifications.kinds, ...(isRecord(n.kinds) ? n.kinds : {}) },
    },
    startAtLogin: typeof p.startAtLogin === 'boolean' ? p.startAtLogin : current.startAtLogin,
    proxyPort: isValidPort(p.proxyPort) ? p.proxyPort : current.proxyPort,
  });
}

/** What `createNotifier` and `notifier.setSettings` take. */
export function toNotifierSettings(s: TraySettings): NotifierSettings {
  return { enabled: s.notifications.enabled, kinds: { ...s.notifications.kinds } };
}

/** Defaults when the file is missing or unreadable; a damaged file is replaced on the next save. */
export async function loadSettings(dataDir: string): Promise<TraySettings> {
  try {
    return normalizeSettings(JSON.parse(await readFile(join(dataDir, SETTINGS_FILE), 'utf8')));
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(dataDir: string, settings: TraySettings): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, SETTINGS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
