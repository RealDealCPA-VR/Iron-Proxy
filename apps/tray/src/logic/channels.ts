import type { LoginCommandInfo } from '@iron-proxy/core';
import type { TraySettings, TraySettingsPatch } from './settings.js';

/** IPC channels between the tray's main process and its window, next to the Iron-Proxy bridge. */
export const TRAY_CHANNELS = {
  /** invoke () -> TrayInfo */
  info: 'iron-tray:info',
  /** invoke (patch: TraySettingsPatch) -> TrayInfo */
  setSettings: 'iron-tray:set-settings',
  /**
   * invoke (cmd: LoginCommandInfo) -> null: opens a vendor login in a terminal window.
   * Main only runs a command that equals one of its own accounts' login commands.
   */
  openTerminal: 'iron-tray:open-terminal',
  /** invoke (text: string) -> null */
  copy: 'iron-tray:copy',
  /** main -> renderer: TrayInfo changed */
  changed: 'iron-tray:changed',
} as const;

/** What the window shows in its header and settings section. */
export interface TrayInfo {
  /** The local proxy the tools should use, when one is running. */
  proxyUrl?: string;
  /** True when this app runs the proxy, false when it reuses one started elsewhere (e.g. `iron-proxy serve`). */
  proxyOwned: boolean;
  /** The port the running proxy actually listens on, when known. */
  proxyPort?: number;
  settings: TraySettings;
  dataDir: string;
}

/** The API the preload exposes as `window.ironTray`. */
export interface TrayBridge {
  info(): Promise<TrayInfo>;
  setSettings(patch: TraySettingsPatch): Promise<TrayInfo>;
  openTerminal(cmd: LoginCommandInfo): Promise<void>;
  copy(text: string): Promise<void>;
  onChanged(listener: (info: TrayInfo) => void): () => void;
}
