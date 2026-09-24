import type { NotificationKind } from '@iron-proxy/electron';

/**
 * Constants and helpers shared by the main process and the window. Browser-safe:
 * no Node imports here (only type imports), so the renderer bundle stays small.
 */

/** The notification kinds the tray offers a switch for (`resumed` is reserved upstream). */
export type TrayNotificationKind = Exclude<NotificationKind, 'resumed'>;

export const TRAY_NOTIFICATION_KINDS: readonly TrayNotificationKind[] = [
  'switched',
  'parked',
  'exhausted',
  'login',
] as const;

export const NOTIFICATION_KIND_LABELS: Readonly<Record<TrayNotificationKind, string>> = {
  switched: 'When an account switches',
  parked: 'When an account needs a rest',
  exhausted: 'When every account is resting',
  login: 'When a sign-in finishes',
};

export const DEFAULT_PROXY_PORT = 8791;

export function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** The two base URLs people paste into SDKs and tools. */
export function baseUrls(proxyUrl: string): { openai: string; anthropic: string } {
  const root = proxyUrl.replace(/\/+$/, '');
  return { openai: `${root}/v1`, anthropic: root };
}
