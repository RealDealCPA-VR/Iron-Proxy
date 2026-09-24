import type {
  IpcMainInvokeEventLike,
  NotificationOptionsLike,
  WebContentsLike,
} from '@iron-proxy/electron';
import type {
  BrowserWindowOptionsLike,
  ElectronMenuItemOptions,
  LoginItemSettingsLike,
  PreventableEventLike,
  TrayElectron,
} from '../src/electron-like.js';

/** Every listener the tray registers takes nothing or a preventable event. */
type Listener = (event: PreventableEventLike) => void;

class Emitter {
  listeners = new Map<string, Listener[]>();
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, arg: PreventableEventLike = { preventDefault() {} }) {
    for (const fn of this.listeners.get(event) ?? []) fn(arg);
  }
}

export class FakeWebContents implements WebContentsLike {
  static seq = 0;
  id = ++FakeWebContents.seq;
  sent: Array<{ channel: string; args: unknown[] }> = [];
  destroyed = false;
  send(channel: string, ...args: unknown[]) {
    this.sent.push({ channel, args });
  }
  isDestroyed() {
    return this.destroyed;
  }
  once(_event: 'destroyed', _listener: () => void) {
    return this;
  }
}

export interface FakeElectron extends TrayElectron {
  app: FakeApp;
  trays: FakeTray[];
  windows: FakeWindow[];
  notifications: NotificationOptionsLike[];
  clipboardText: string[];
  ipc: FakeIpcMain;
  menus: ElectronMenuItemOptions[][];
}

export class FakeApp extends Emitter {
  lock = true;
  quitCalls = 0;
  loginItems: LoginItemSettingsLike[] = [];
  isPackaged = false;
  dock = { hidden: false, hide: () => (this.dock.hidden = true) };
  async whenReady() {}
  requestSingleInstanceLock() {
    return this.lock;
  }
  quit() {
    this.quitCalls++;
    // Like Electron: quitting emits before-quit, which a listener may prevent.
    let prevented = false;
    const e: PreventableEventLike = { preventDefault: () => (prevented = true) };
    this.emit('before-quit', e);
    return prevented;
  }
  setLoginItemSettings(s: LoginItemSettingsLike) {
    this.loginItems.push(s);
  }
  getAppPath() {
    return '/fake/app';
  }
}

export class FakeTray extends Emitter {
  tooltip = '';
  menu: unknown;
  destroyed = false;
  constructor(readonly image: string) {
    super();
  }
  setToolTip(t: string) {
    this.tooltip = t;
  }
  setContextMenu(m: unknown) {
    this.menu = m;
  }
  destroy() {
    this.destroyed = true;
  }
}

export class FakeWindow extends Emitter {
  webContents = new FakeWebContents();
  loaded: string[] = [];
  visible = false;
  destroyed = false;
  constructor(readonly options: BrowserWindowOptionsLike) {
    super();
  }
  reloads = 0;
  async loadFile(path: string) {
    this.loaded.push(path);
  }
  reload() {
    this.reloads++;
  }
  show() {
    this.visible = true;
  }
  focus() {}
  hide() {
    this.visible = false;
  }
  isMinimized() {
    return false;
  }
  restore() {}
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.webContents.destroyed = true;
  }
  /** What the user's close button does: returns true when the close was prevented. */
  close(): boolean {
    let prevented = false;
    this.emit('close', { preventDefault: () => (prevented = true) });
    if (!prevented) this.destroy();
    return prevented;
  }
}

type Handler = (event: IpcMainInvokeEventLike, ...args: unknown[]) => unknown;

export class FakeIpcMain {
  handlers = new Map<string, Handler>();
  listeners = new Map<string, Set<Handler>>();
  handle(channel: string, fn: Handler) {
    if (this.handlers.has(channel)) throw new Error(`handler for ${channel} already registered`);
    this.handlers.set(channel, fn);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
  on(channel: string, fn: Handler) {
    const set = this.listeners.get(channel) ?? new Set();
    set.add(fn);
    this.listeners.set(channel, set);
    return this;
  }
  removeListener(channel: string, fn: Handler) {
    this.listeners.get(channel)?.delete(fn);
    return this;
  }
  listenerCount() {
    let n = 0;
    for (const s of this.listeners.values()) n += s.size;
    return n;
  }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler for ${channel}`);
    return fn({ sender: new FakeWebContents() }, ...args);
  }
}

export function createFakeElectron(): FakeElectron {
  const trays: FakeTray[] = [];
  const windows: FakeWindow[] = [];
  const notifications: NotificationOptionsLike[] = [];
  const clipboardText: string[] = [];
  const menus: ElectronMenuItemOptions[][] = [];
  const ipc = new FakeIpcMain();
  class Tray extends FakeTray {
    constructor(image: string) {
      super(image);
      trays.push(this);
    }
  }
  class BrowserWindow extends FakeWindow {
    constructor(options: BrowserWindowOptionsLike) {
      super(options);
      windows.push(this);
    }
  }
  class Notification {
    static isSupported() {
      return true;
    }
    constructor(readonly options: NotificationOptionsLike) {}
    show() {
      notifications.push(this.options);
    }
  }
  return {
    app: new FakeApp(),
    Tray,
    BrowserWindow,
    Menu: {
      buildFromTemplate(template: ElectronMenuItemOptions[]) {
        menus.push(template);
        return { template };
      },
    },
    ipcMain: ipc,
    ipc,
    Notification,
    clipboard: { writeText: (t: string) => void clipboardText.push(t) },
    trays,
    windows,
    notifications,
    clipboardText,
    menus,
  };
}

/** Find a menu item (searching submenus) by id. */
export function findItem(
  items: readonly ElectronMenuItemOptions[],
  id: string,
): ElectronMenuItemOptions | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const inner = item.submenu ? findItem(item.submenu, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}
