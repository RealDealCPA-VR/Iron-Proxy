import { watch as fsWatch } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createIronProxy,
  defaultDataDir,
  type IronEvent,
  type IronProxy,
  type LoginCommandInfo,
} from '@iron-proxy/core';
import {
  createNotifier,
  installIronProxy,
  openLoginTerminal as defaultOpenLoginTerminal,
  type IronProxyInstallation,
  type Notifier,
} from '@iron-proxy/electron';
import { createProxyServer, type ProxyServer, type ProxyServerOptions } from '@iron-proxy/proxy';
import type { BrowserWindowLike, TrayElectron, TrayLike } from './electron-like.js';
import { TRAY_CHANNELS, type TrayInfo } from './logic/channels.js';
import {
  activeAccounts,
  buildTrayMenu,
  toElectronTemplate,
  trayTooltip,
  type MenuTemplateItem,
  type TrayAction,
} from './logic/menu.js';
import {
  decideProxy,
  isPidAlive,
  readDescriptor,
  removeDescriptorIfOwned,
  writeDescriptor,
} from './logic/proxy.js';
import {
  applySettingsPatch,
  loadSettings,
  saveSettings,
  toNotifierSettings,
  type TraySettings,
} from './logic/settings.js';

export interface TrayTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Watches a directory; the listener gets the changed file's name when the OS reports it. */
export type WatchDir = (dir: string, onChange: (filename?: string) => void) => { close(): void };

/** fs.watch on the data directory. Local file events only: nothing is polled, no quota is spent. */
export const watchDataDir: WatchDir = (dir, onChange) => {
  const w = fsWatch(dir, { persistent: false }, (_event, name) =>
    onChange(typeof name === 'string' ? name : undefined),
  );
  w.on('error', () => {});
  return w;
};

export interface StartTrayAppOptions {
  electron: TrayElectron;
  /** Where index.html and preload.cjs live (the build's out/ directory). */
  outDir: string;
  /** Where the icons live. */
  assetsDir: string;
  /** Default: the CLI's data directory (`IRON_PROXY_DATA_DIR`, else `~/.iron-proxy`). */
  dataDir?: string;
  platform?: NodeJS.Platform;
  /** This process's pid, written into proxy.json. */
  pid?: number;
  /** For start at login when running unpackaged (`electron .`). */
  execPath?: string;
  isAlive?: (pid: number) => boolean;
  createServer?: (opts: ProxyServerOptions) => ProxyServer;
  openLoginTerminal?: (cmd: LoginCommandInfo) => Promise<unknown>;
  timers?: TrayTimers;
  /**
   * Notices when the CLI or a running `serve` changes profiles.json / state.json,
   * so the menu and window follow. Default `watchDataDir` (fs.watch).
   */
  watch?: WatchDir;
  /** Quiet period before the menu rebuilds after a burst of events. Default 250 ms. */
  debounceMs?: number;
  locale?: string;
  timeZone?: string;
  onError?: (err: unknown) => void;
}

export interface TrayAppHandle {
  readonly iron: IronProxy;
  readonly dataDir: string;
  info(): TrayInfo;
  /** The menu as last built. */
  menu(): MenuTemplateItem[];
  tooltip(): string;
  /** Run a menu action, as a click would. */
  dispatch(action: TrayAction): Promise<void>;
  /** Rebuild the menu and tooltip now. */
  refresh(): Promise<void>;
  showWindow(): Promise<void>;
  /** Stop everything and quit the app. */
  quit(): Promise<void>;
  /** Stop everything without quitting (tests, and the before-quit path). */
  shutdown(): Promise<void>;
}

const systemTimers: TrayTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** setTimeout's ceiling (~24.8 days). */
const MAX_DELAY = 2_147_483_647;
const LOOPBACK = '127.0.0.1';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameCommand(a: LoginCommandInfo, b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  const c = b as Partial<LoginCommandInfo>;
  const canon = (x: Partial<LoginCommandInfo>) =>
    JSON.stringify([
      x.binary,
      x.args,
      Object.entries(x.env ?? {}).sort(([k1], [k2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : 0)),
    ]);
  return canon(a) === canon(c);
}

/**
 * Wire the tray app: shared data dir, local proxy (or the one already running),
 * IPC bridge, notifications, tray menu and window. Resolves undefined when
 * another instance holds the single-instance lock (that one is focused instead).
 */
export async function startTrayApp(opts: StartTrayAppOptions): Promise<TrayAppHandle | undefined> {
  const { app, Tray, Menu, BrowserWindow, ipcMain, Notification, clipboard } = opts.electron;
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return undefined;
  }

  const platform = opts.platform ?? process.platform;
  const pid = opts.pid ?? process.pid;
  const timers = opts.timers ?? systemTimers;
  const debounceMs = opts.debounceMs ?? 250;
  const isAlive = opts.isAlive ?? ((p: number) => isPidAlive(p));
  const createServer = opts.createServer ?? createProxyServer;
  const openTerminal = opts.openLoginTerminal ?? defaultOpenLoginTerminal;
  const onError =
    opts.onError ?? ((err: unknown) => console.error(`[iron-proxy tray] ${errorMessage(err)}`));

  // The CLI's directory, so accounts are shared both ways. Same file vault and
  // the same plain key protector as the CLI, so either can read the other's keys.
  const dataDir = opts.dataDir ?? defaultDataDir();

  await app.whenReady();
  // A tray app: closing the window must not quit.
  app.on('window-all-closed', () => {});
  if (platform === 'darwin') app.dock?.hide();

  let settings: TraySettings = await loadSettings(dataDir);
  await mkdir(dataDir, { recursive: true });
  const iron = createIronProxy({ dataDir });

  /* ---------------- proxy ---------------- */

  let server: ProxyServer | undefined;
  let proxyUrl: string | undefined;
  let proxyPort: number | undefined;

  async function listenOn(port: number): Promise<void> {
    const make = (p: number) =>
      createServer({ iron, host: LOOPBACK, port: p, requireAuthForModels: false });
    let s = make(port);
    let info: Awaited<ReturnType<ProxyServer['listen']>>;
    try {
      info = await s.listen();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
      await s.close().catch(() => {});
      s = make(0); // the preferred port is taken: any free one
      info = await s.listen();
    }
    server = s;
    proxyUrl = info.url;
    proxyPort = info.port;
    await writeDescriptor(dataDir, { url: info.url, token: info.token, pid });
  }

  async function stopOwnProxy(): Promise<void> {
    const s = server;
    server = undefined;
    if (!s) return;
    await s.close().catch(onError);
    await removeDescriptorIfOwned(dataDir, pid).catch(onError);
  }

  async function startOrReuseProxy(): Promise<void> {
    const decision = decideProxy(await readDescriptor(dataDir), isAlive, pid);
    if (decision.action === 'reuse') {
      proxyUrl = decision.descriptor.url;
      const port = Number(new URL(decision.descriptor.url).port);
      proxyPort = Number.isInteger(port) && port > 0 ? port : undefined;
      return;
    }
    try {
      await listenOn(settings.proxyPort);
    } catch (err) {
      proxyUrl = undefined;
      proxyPort = undefined;
      onError(err);
    }
  }

  await startOrReuseProxy();

  /* ---------------- bridge + notifications ---------------- */

  const installation: IronProxyInstallation = installIronProxy({ ipcMain, iron });
  const notifier: Notifier = createNotifier({
    iron,
    Notification,
    settings: toNotifierSettings(settings),
    onError,
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  });

  /* ---------------- window ---------------- */

  let win: BrowserWindowLike | undefined;
  let quitting = false;
  /** profiles.json or state.json changed on disk since the window last loaded. */
  let externalChange = false;

  function info(): TrayInfo {
    return {
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(proxyPort !== undefined ? { proxyPort } : {}),
      proxyOwned: server !== undefined,
      settings,
      dataDir,
    };
  }

  function sendChanged(): void {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    try {
      win.webContents.send(TRAY_CHANNELS.changed, info());
    } catch (err) {
      onError(err);
    }
  }

  async function showWindow(): Promise<void> {
    if (quitting) return;
    if (win && !win.isDestroyed()) {
      // The CLI (or a running serve) changed accounts while the window was hidden.
      if (externalChange) win.reload();
      externalChange = false;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    const w = new BrowserWindow({
      width: 420,
      height: 640,
      show: false,
      title: 'Iron-Proxy',
      icon: join(opts.assetsDir, 'icon-256.png'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(opts.outDir, 'preload.cjs'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    win = w;
    externalChange = false;
    // Closing hides; only Quit in the tray menu ends the app.
    w.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      w.hide();
    });
    await w.loadFile(join(opts.outDir, 'index.html'));
    w.show();
    w.focus();
  }

  app.on('second-instance', () => void showWindow().catch(onError));

  /* ---------------- settings ---------------- */

  function applyLoginItem(openAtLogin: boolean): void {
    try {
      app.setLoginItemSettings(
        app.isPackaged
          ? { openAtLogin }
          : { openAtLogin, path: opts.execPath ?? process.execPath, args: [app.getAppPath()] },
      );
    } catch (err) {
      onError(err);
    }
  }

  async function updateSettings(patch: unknown): Promise<TrayInfo> {
    const prev = settings;
    settings = applySettingsPatch(prev, patch);
    await saveSettings(dataDir, settings);
    notifier.setSettings(toNotifierSettings(settings));
    if (settings.startAtLogin !== prev.startAtLogin) applyLoginItem(settings.startAtLogin);
    // A new port applies at once when this app runs the proxy; a proxy started
    // elsewhere (iron-proxy serve) is left alone and the port is used next time.
    if (settings.proxyPort !== prev.proxyPort && server) {
      await stopOwnProxy();
      try {
        await listenOn(settings.proxyPort);
      } catch (err) {
        proxyUrl = undefined;
        proxyPort = undefined;
        onError(err);
      }
    }
    scheduleRefresh(0);
    sendChanged();
    return info();
  }

  /* ---------------- tray + menu ---------------- */

  const tray: TrayLike = new Tray(
    join(opts.assetsDir, platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'),
  );
  tray.setToolTip('Iron-Proxy');
  if (platform !== 'darwin') tray.on('click', () => void showWindow().catch(onError));

  let lastMenu: MenuTemplateItem[] = [];
  let lastTooltip = 'Iron-Proxy';
  let debounceTimer: unknown;
  let expiryTimer: unknown;
  let refreshing: Promise<void> = Promise.resolve();
  let disposed = false;

  async function rebuild(): Promise<void> {
    if (disposed) return;
    const [profiles, states] = await Promise.all([iron.listProfiles(), iron.allStates()]);
    if (disposed) return;
    const now = timers.now();
    const providers = iron.registry.list().map((a) => ({ id: a.id }));
    const activeByProvider = activeAccounts(profiles, states, now);
    const model = {
      providers,
      profiles,
      states,
      activeByProvider,
      settings,
      now,
      platform,
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
      ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    };
    lastMenu = buildTrayMenu(model);
    lastTooltip = trayTooltip(model);
    tray.setContextMenu(
      Menu.buildFromTemplate(toElectronTemplate(lastMenu, (a) => void dispatch(a).catch(onError))),
    );
    tray.setToolTip(lastTooltip);

    // Relabel once the next parked account's rest is over. One timer, no polling.
    if (expiryTimer !== undefined) timers.clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const next = Object.values(states)
      .map((s) => (s.status === 'parked' && s.parkedUntil ? Date.parse(s.parkedUntil) : NaN))
      .filter((t) => Number.isFinite(t) && t > now)
      .sort((a, b) => a - b)[0];
    if (next !== undefined) {
      expiryTimer = timers.setTimeout(
        () => {
          expiryTimer = undefined;
          scheduleRefresh(0);
        },
        Math.min(next - now + 1_000, MAX_DELAY),
      );
    }
  }

  function refresh(): Promise<void> {
    refreshing = refreshing.then(rebuild).catch(onError);
    return refreshing;
  }

  function scheduleRefresh(ms = debounceMs): void {
    if (disposed) return;
    if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer);
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, ms);
  }

  const relevant = (e: IronEvent): boolean =>
    e.type.startsWith('profile.') ||
    e.type === 'provider.exhausted' ||
    (e.type === 'login' && (e.event.type === 'completed' || e.event.type === 'failed'));
  const offEvents = iron.events.onAny((e) => {
    if (relevant(e)) scheduleRefresh();
  });

  // Accounts and parks written by other processes on the same data directory.
  let watcher: { close(): void } | undefined;
  try {
    watcher = (opts.watch ?? watchDataDir)(dataDir, (name) => {
      if (name !== undefined && !/^(profiles|state)\.json/.test(name)) return;
      externalChange = true;
      scheduleRefresh();
    });
  } catch (err) {
    onError(err);
  }

  /* ---------------- actions ---------------- */

  async function dispatch(action: TrayAction): Promise<void> {
    switch (action.type) {
      case 'activate':
        await iron.activate(action.profileId);
        await refresh();
        return;
      case 'open-window':
        await showWindow();
        return;
      case 'copy':
        clipboard.writeText(action.text);
        return;
      case 'toggle-notifications':
        await updateSettings({ notifications: { enabled: !settings.notifications.enabled } });
        return;
      case 'toggle-notification-kind':
        await updateSettings({
          notifications: {
            kinds: { [action.kind]: !settings.notifications.kinds[action.kind] },
          },
        });
        return;
      case 'toggle-start-at-login':
        await updateSettings({ startAtLogin: !settings.startAtLogin });
        return;
      case 'quit':
        await quit();
        return;
    }
  }

  /* ---------------- window IPC ---------------- */

  ipcMain.handle(TRAY_CHANNELS.info, () => info());
  ipcMain.handle(TRAY_CHANNELS.setSettings, (_e, patch) => updateSettings(patch));
  ipcMain.handle(TRAY_CHANNELS.copy, (_e, text) => {
    if (typeof text === 'string') clipboard.writeText(text);
    return null;
  });
  ipcMain.handle(TRAY_CHANNELS.openTerminal, async (_e, cmd) => {
    // Only a login command main itself would produce for one of the accounts:
    // the window cannot use this channel to run anything else.
    for (const p of await iron.listProfiles()) {
      if (p.lane !== 'cli') continue;
      const own = await iron.loginCommand(p.id).catch(() => undefined);
      if (own && sameCommand(own, cmd)) {
        await openTerminal(own);
        return null;
      }
    }
    throw new Error('That sign-in command does not belong to any account here.');
  });

  /* ---------------- shutdown ---------------- */

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      quitting = true;
      disposed = true;
      if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer);
      if (expiryTimer !== undefined) timers.clearTimeout(expiryTimer);
      offEvents();
      try {
        watcher?.close();
      } catch (err) {
        onError(err);
      }
      notifier.dispose();
      installation.dispose();
      for (const ch of [
        TRAY_CHANNELS.info,
        TRAY_CHANNELS.setSettings,
        TRAY_CHANNELS.copy,
        TRAY_CHANNELS.openTerminal,
      ])
        ipcMain.removeHandler(ch);
      await refreshing.catch(() => {});
      await stopOwnProxy();
      try {
        tray.destroy();
      } catch (err) {
        onError(err);
      }
      if (win && !win.isDestroyed()) win.destroy();
      win = undefined;
      await iron.close().catch(onError);
    })();
    return shutdownPromise;
  }

  async function quit(): Promise<void> {
    await shutdown();
    app.quit();
  }

  // Quitting from elsewhere (OS logout, Cmd+Q): finish the cleanup first.
  app.on('before-quit', (e) => {
    if (shutdownPromise) return;
    e.preventDefault();
    void quit();
  });

  await refresh();

  return {
    iron,
    dataDir,
    info,
    menu: () => lastMenu,
    tooltip: () => lastTooltip,
    dispatch,
    refresh,
    showWindow,
    quit,
    shutdown,
  };
}
