/**
 * Structural subsets of the Electron API the tray touches. `main.ts` passes the
 * real modules; tests pass fakes, so the whole wiring runs in plain Node
 * without the Electron binary.
 */
import type { IpcMainLike, NotificationClassLike, WebContentsLike } from '@iron-proxy/electron';

export interface PreventableEventLike {
  preventDefault(): void;
}

export interface LoginItemSettingsLike {
  openAtLogin: boolean;
  path?: string;
  args?: string[];
}

export interface TrayAppLike {
  whenReady(): Promise<unknown>;
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
  on(event: 'window-all-closed', listener: () => void): unknown;
  on(event: 'before-quit', listener: (event: PreventableEventLike) => void): unknown;
  quit(): void;
  setLoginItemSettings(settings: LoginItemSettingsLike): void;
  getAppPath(): string;
  readonly isPackaged: boolean;
  dock?: { hide(): void } | undefined;
}

/** What `Menu.buildFromTemplate` accepts: Electron's MenuItemConstructorOptions, narrowed. */
export interface ElectronMenuItemOptions {
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio';
  checked?: boolean;
  enabled?: boolean;
  submenu?: ElectronMenuItemOptions[];
  click?: () => void;
}

export interface MenuModuleLike {
  buildFromTemplate(template: ElectronMenuItemOptions[]): unknown;
}

export interface TrayLike {
  setToolTip(text: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): unknown;
  destroy(): void;
}

export interface TrayClassLike {
  /** A PNG path; Electron picks the @2x/@4x siblings and treats *Template.png as a macOS template. */
  new (image: string): TrayLike;
}

export interface BrowserWindowOptionsLike {
  width: number;
  height: number;
  show: boolean;
  title: string;
  icon?: string;
  autoHideMenuBar?: boolean;
  webPreferences: {
    preload: string;
    contextIsolation: boolean;
    sandbox: boolean;
    nodeIntegration: boolean;
  };
}

export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  loadFile(path: string): Promise<unknown>;
  reload(): void;
  show(): void;
  focus(): void;
  hide(): void;
  isMinimized(): boolean;
  restore(): void;
  isDestroyed(): boolean;
  destroy(): void;
  on(event: 'close', listener: (event: PreventableEventLike) => void): unknown;
}

export interface BrowserWindowClassLike {
  new (options: BrowserWindowOptionsLike): BrowserWindowLike;
}

export interface ClipboardLike {
  writeText(text: string): void;
}

/** Everything the tray needs from `electron`. */
export interface TrayElectron {
  app: TrayAppLike;
  Tray: TrayClassLike;
  Menu: MenuModuleLike;
  BrowserWindow: BrowserWindowClassLike;
  ipcMain: IpcMainLike;
  Notification: NotificationClassLike;
  clipboard: ClipboardLike;
}
