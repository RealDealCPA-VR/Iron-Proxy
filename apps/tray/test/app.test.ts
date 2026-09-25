import { mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIronProxy, type LoginCommandInfo } from '@iron-proxy/core';
import { createProxyServer, type ProxyServer, type ProxyServerOptions } from '@iron-proxy/proxy';
import { startTrayApp, type TrayAppHandle } from '../src/app.js';
import { TRAY_CHANNELS, type TrayInfo } from '../src/logic/channels.js';
import { defaultSettings, saveSettings, SETTINGS_FILE } from '../src/logic/settings.js';
import { createFakeElectron, findItem, type FakeElectron } from './fake-electron.js';

const FAKE_CLI = fileURLToPath(
  new URL('../../../packages/core/test/fixtures/fake-cli/fake-cli.mjs', import.meta.url),
);

let dir: string;
let blocker: Server | undefined;
let handle: TrayAppHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-tray-app-'));
});
afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  await new Promise<void>((r) => (blocker ? blocker.close(() => r()) : r()));
  blocker = undefined;
  // A vendor CLI child (the fake) may still hold a home directory for a moment on Windows.
  await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** Occupy a loopback port so the tray has to fall back to a free one. */
async function takenPort(): Promise<number> {
  blocker = createNetServer();
  await new Promise<void>((r) => blocker!.listen(0, '127.0.0.1', () => r()));
  const addr = blocker.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function start(electron: FakeElectron, extra: Partial<Parameters<typeof startTrayApp>[0]> = {}) {
  return startTrayApp({
    electron,
    outDir: '/fake/out',
    assetsDir: '/fake/assets',
    dataDir: dir,
    platform: 'win32',
    debounceMs: 0,
    locale: 'en-US',
    timeZone: 'UTC',
    onError: (err) => {
      throw err;
    },
    ...extra,
  });
}

describe('tray app wiring', () => {
  it('starts the proxy, writes proxy.json, drives the menu, and quit disposes everything', async () => {
    const port = await takenPort();
    await saveSettings(dir, { ...defaultSettings(), proxyPort: port });
    const electron = createFakeElectron();
    handle = await start(electron);
    const h = handle!;
    expect(h.dataDir).toBe(dir);

    // Proxy: preferred port taken, so a free one; proxy.json in the CLI's shape.
    const descriptor = JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'));
    expect(Object.keys(descriptor).sort()).toEqual(['pid', 'token', 'url']);
    expect(descriptor.pid).toBe(process.pid);
    expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(descriptor.url).not.toBe(`http://127.0.0.1:${port}`);
    expect((await fetch(`${descriptor.url}/iron/health`)).status).toBe(200);
    expect(h.info()).toMatchObject({ proxyUrl: descriptor.url, proxyOwned: true });

    // Tray: colored icon off macOS, tooltip and the empty-state menu.
    const tray = electron.trays[0]!;
    expect(electron.trays).toHaveLength(1);
    expect(tray.image).toBe(join('/fake/assets', 'tray.png'));
    expect(tray.tooltip).toBe('Iron-Proxy: no accounts yet');
    expect(h.menu()[0]).toMatchObject({ id: 'add-account' });
    expect(findItem(electron.menus.at(-1)!, 'copy-openai')).toBeDefined();

    // IPC: the IronClient bridge and the tray's own channels.
    expect([...electron.ipc.handlers.keys()].sort()).toEqual(
      [
        'iron-proxy:call',
        TRAY_CHANNELS.copy,
        TRAY_CHANNELS.info,
        TRAY_CHANNELS.openTerminal,
        TRAY_CHANNELS.setSettings,
      ].sort(),
    );
    const listed = await electron.ipc.invoke('iron-proxy:call', 'listProfiles');
    expect(listed).toEqual([]);

    // Accounts added (here straight on the engine, as the CLI would) rebuild the menu.
    const work = await h.iron.createProfile({
      title: 'Work Claude Max',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'sk-work-secret',
    });
    const home = await h.iron.createProfile({
      title: 'Home Claude',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'sk-home-secret',
    });
    await vi.waitFor(() => expect(tray.tooltip).toBe('Iron-Proxy: Claude on "Work Claude Max"'));
    expect(findItem(h.menu(), `account-${work.id}`)?.checked).toBe(true);

    // Clicking the other account activates it: the radio and tooltip follow.
    await vi.waitFor(() =>
      expect(findItem(electron.menus.at(-1)!, `account-${home.id}`)).toBeDefined(),
    );
    findItem(electron.menus.at(-1)!, `account-${home.id}`)!.click!();
    await vi.waitFor(() => expect(tray.tooltip).toBe('Iron-Proxy: Claude on "Home Claude"'));
    expect((await h.iron.listProfiles()).map((p) => p.id)).toEqual([home.id, work.id]);
    expect(findItem(electron.menus.at(-1)!, `account-${home.id}`)?.checked).toBe(true);

    // Copy base URLs.
    findItem(electron.menus.at(-1)!, 'copy-openai')!.click!();
    findItem(electron.menus.at(-1)!, 'copy-anthropic')!.click!();
    expect(electron.clipboardText).toEqual([`${descriptor.url}/v1`, descriptor.url]);

    // Start at login: Electron is told, and the setting is saved.
    await h.dispatch({ type: 'toggle-start-at-login' });
    expect(electron.app.loginItems).toEqual([
      { openAtLogin: true, path: process.execPath, args: ['/fake/app'] },
    ]);
    const saved = JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8'));
    expect(saved.startAtLogin).toBe(true);
    await vi.waitFor(() =>
      expect(findItem(electron.menus.at(-1)!, 'start-at-login')?.checked).toBe(true),
    );

    // Window: created on demand, 420x640, preload + index.html, hidden on close.
    await h.dispatch({ type: 'open-window' });
    const win = electron.windows[0]!;
    expect(win.options).toMatchObject({ width: 420, height: 640, title: 'Iron-Proxy' });
    expect(win.options.webPreferences).toMatchObject({
      preload: join('/fake/out', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(win.loaded).toEqual([join('/fake/out', 'index.html')]);
    expect(win.visible).toBe(true);
    expect(win.close()).toBe(true);
    expect(win.visible).toBe(false);
    expect(win.destroyed).toBe(false);
    // A second launch focuses the same window.
    electron.app.emit('second-instance');
    await vi.waitFor(() => expect(win.visible).toBe(true));
    // So does a click on the tray icon (Windows and Linux).
    win.close();
    tray.emit('click');
    await vi.waitFor(() => expect(win.visible).toBe(true));
    expect(electron.windows).toHaveLength(1);

    // Settings through IPC reach the window as a change event.
    const info = (await electron.ipc.invoke(TRAY_CHANNELS.setSettings, {
      notifications: { kinds: { parked: false } },
    })) as TrayInfo;
    expect(info.settings.notifications.kinds.parked).toBe(false);
    expect(win.webContents.sent.some((m) => m.channel === TRAY_CHANNELS.changed)).toBe(true);

    // Quit from the menu: everything is disposed.
    findItem(electron.menus.at(-1)!, 'quit')!.click!();
    await vi.waitFor(() => expect(electron.app.quitCalls).toBe(1));
    await h.shutdown();
    expect(await exists(join(dir, 'proxy.json'))).toBe(false);
    await expect(fetch(`${descriptor.url}/iron/health`)).rejects.toThrow();
    expect(tray.destroyed).toBe(true);
    expect(win.destroyed).toBe(true);
    expect(electron.ipc.handlers.size).toBe(0);
    expect(electron.ipc.listenerCount()).toBe(0);
    // The before-quit that app.quit() emitted was let through (nothing left to clean).
    expect(electron.app.quit()).toBe(false);
    // Nothing secret went anywhere visible.
    const visible = JSON.stringify([electron.menus, tray.tooltip, electron.notifications]);
    expect(visible).not.toContain('sk-');
    handle = undefined;
  });

  it('reuses a proxy another live process runs, and leaves its proxy.json alone', async () => {
    const other = { url: 'http://127.0.0.1:45678', token: 'other-token', pid: 999_999 };
    await writeFile(join(dir, 'proxy.json'), JSON.stringify(other));
    const electron = createFakeElectron();
    const createServer = vi.fn((o: ProxyServerOptions) => createProxyServer(o));
    const prev = process.env.IRON_PROXY_DATA_DIR;
    process.env.IRON_PROXY_DATA_DIR = dir;
    try {
      handle = await startTrayApp({
        electron,
        outDir: '/o',
        assetsDir: '/a',
        platform: 'darwin',
        isAlive: (pid) => pid === other.pid,
        createServer,
        debounceMs: 0,
      });
    } finally {
      if (prev === undefined) delete process.env.IRON_PROXY_DATA_DIR;
      else process.env.IRON_PROXY_DATA_DIR = prev;
    }
    const h = handle!;
    // The shared data dir comes from IRON_PROXY_DATA_DIR, like the CLI's.
    expect(h.dataDir).toBe(dir);
    expect(createServer).not.toHaveBeenCalled();
    expect(h.info()).toMatchObject({ proxyUrl: other.url, proxyOwned: false, proxyPort: 45678 });
    expect(findItem(electron.menus.at(-1)!, 'copy-openai')).toBeDefined();
    expect(h.menu().find((i) => i.id === 'copy-openai')?.action).toEqual({
      type: 'copy',
      text: `${other.url}/v1`,
    });
    // macOS: template icon, no Dock icon.
    expect(electron.trays[0]!.image).toBe(join('/a', 'trayTemplate.png'));
    expect(electron.app.dock.hidden).toBe(true);

    await h.shutdown();
    handle = undefined;
    expect(JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'))).toEqual(other);
  });

  it('replaces a stale proxy.json whose process is gone', async () => {
    await writeFile(
      join(dir, 'proxy.json'),
      JSON.stringify({ url: 'http://127.0.0.1:1', token: 'x', pid: 999_998 }),
    );
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    const electron = createFakeElectron();
    handle = await start(electron, { isAlive: () => false });
    const d = JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'));
    expect(d.pid).toBe(process.pid);
    expect(handle!.info().proxyOwned).toBe(true);
  });

  it('a second instance quits at once and builds nothing', async () => {
    const electron = createFakeElectron();
    electron.app.lock = false;
    expect(await start(electron)).toBeUndefined();
    expect(electron.app.quitCalls).toBe(1);
    expect(electron.trays).toHaveLength(0);
    expect(electron.ipc.handlers.size).toBe(0);
    expect(await exists(join(dir, 'proxy.json'))).toBe(false);
  });

  it('shows desktop notifications per the saved settings', async () => {
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    const electron = createFakeElectron();
    handle = await start(electron);
    const h = handle!;
    h.iron.events.emit({ type: 'provider.exhausted', provider: 'anthropic' });
    await vi.waitFor(() => expect(electron.notifications).toHaveLength(1));
    expect(electron.notifications[0]!.title).toBe('All Claude accounts are resting');

    await h.dispatch({ type: 'toggle-notification-kind', kind: 'exhausted' });
    h.iron.events.emit({ type: 'provider.exhausted', provider: 'openai' });
    await h.dispatch({ type: 'toggle-notifications' });
    h.iron.events.emit({ type: 'provider.exhausted', provider: 'xai' });
    await new Promise((r) => setTimeout(r, 50));
    expect(electron.notifications).toHaveLength(1);
    expect(h.info().settings.notifications).toMatchObject({
      enabled: false,
      kinds: { exhausted: false },
    });
  });

  it('opens a terminal login only for a command that belongs to an account', async () => {
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    const electron = createFakeElectron();
    const opened: LoginCommandInfo[] = [];
    handle = await start(electron, {
      openLoginTerminal: async (cmd) => {
        opened.push(cmd);
      },
    });
    const h = handle!;
    const p = await h.iron.createProfile({
      title: 'Terminal Claude',
      provider: 'anthropic',
      lane: 'cli',
      cli: { home: join(dir, 'homes', 'term'), binary: FAKE_CLI },
    });
    const cmd = await h.iron.loginCommand(p.id);
    // What the renderer sends has been through structured clone: equal, not identical.
    expect(
      await electron.ipc.invoke(TRAY_CHANNELS.openTerminal, JSON.parse(JSON.stringify(cmd))),
    ).toBeNull();
    expect(opened).toEqual([cmd]);

    await expect(
      electron.ipc.invoke(TRAY_CHANNELS.openTerminal, { ...cmd, binary: 'calc.exe' }),
    ).rejects.toThrow(/does not belong/);
    await expect(
      electron.ipc.invoke(TRAY_CHANNELS.openTerminal, { ...cmd, args: [...cmd.args, '--evil'] }),
    ).rejects.toThrow(/does not belong/);
    expect(opened).toHaveLength(1);
  });

  it('starts its own proxy when the proxy it was sharing goes away', async () => {
    const other = { url: 'http://127.0.0.1:45679', token: 'other-token', pid: 999_997 };
    await writeFile(join(dir, 'proxy.json'), JSON.stringify(other));
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    const alive = new Set([other.pid]);
    let changed: ((name?: string) => void) | undefined;
    const electron = createFakeElectron();
    handle = await start(electron, {
      isAlive: (pid) => alive.has(pid),
      watch: (_dir, onChange) => {
        changed = onChange;
        return { close() {} };
      },
    });
    const h = handle!;
    expect(h.info()).toMatchObject({ proxyUrl: other.url, proxyOwned: false });
    await h.dispatch({ type: 'open-window' });
    const win = electron.windows[0]!;

    // `iron-proxy serve` stops and removes its proxy.json: the watcher sees it.
    await unlink(join(dir, 'proxy.json'));
    changed!('proxy.json');
    await vi.waitFor(() => expect(h.info().proxyOwned).toBe(true));
    const mine = JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'));
    expect(mine.pid).toBe(process.pid);
    expect(h.info().proxyUrl).toBe(mine.url);
    expect((await fetch(`${mine.url}/iron/health`)).status).toBe(200);
    // The window hears about the new URL, and the menu copies it.
    await vi.waitFor(() =>
      expect(
        win.webContents.sent.some(
          (m) =>
            m.channel === TRAY_CHANNELS.changed && (m.args[0] as TrayInfo).proxyUrl === mine.url,
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(h.menu().find((i) => i.id === 'copy-openai')?.action).toEqual({
        type: 'copy',
        text: `${mine.url}/v1`,
      }),
    );
  });

  it('starts its own proxy on a menu rebuild once the shared one has exited', async () => {
    const other = { url: 'http://127.0.0.1:45680', token: 'other-token', pid: 999_996 };
    await writeFile(join(dir, 'proxy.json'), JSON.stringify(other));
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    const alive = new Set([other.pid]);
    const electron = createFakeElectron();
    // No file event arrives (the process was killed and left proxy.json behind).
    handle = await start(electron, {
      isAlive: (pid) => alive.has(pid),
      watch: () => ({ close() {} }),
    });
    const h = handle!;
    await h.refresh();
    expect(h.info().proxyOwned).toBe(false);
    alive.delete(other.pid);
    await h.refresh();
    expect(h.info().proxyOwned).toBe(true);
    const mine = JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'));
    expect(mine.pid).toBe(process.pid);
    expect((await fetch(`${mine.url}/iron/health`)).status).toBe(200);
  });

  it('starts listening on a newly saved port when no proxy is running', async () => {
    let failing = true;
    const errors: unknown[] = [];
    const createServer = (o: ProxyServerOptions): ProxyServer => {
      const s = createProxyServer(o);
      if (failing) {
        s.listen = async () => {
          throw Object.assign(new Error('refused'), { code: 'EFAKE' });
        };
      }
      return s;
    };
    const electron = createFakeElectron();
    handle = await start(electron, { createServer, onError: (err) => errors.push(err) });
    const h = handle!;
    expect(h.info().proxyUrl).toBeUndefined();
    expect(errors).toHaveLength(1);

    failing = false;
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const wanted = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const info = (await electron.ipc.invoke(TRAY_CHANNELS.setSettings, {
      proxyPort: wanted,
    })) as TrayInfo;
    expect(info).toMatchObject({
      proxyUrl: `http://127.0.0.1:${wanted}`,
      proxyPort: wanted,
      proxyOwned: true,
    });
    expect((await fetch(`${info.proxyUrl}/iron/health`)).status).toBe(200);
  });

  it("leaves another process's running proxy alone when the port changes", async () => {
    const other = { url: 'http://127.0.0.1:45681', token: 'other-token', pid: 999_995 };
    await writeFile(join(dir, 'proxy.json'), JSON.stringify(other));
    const electron = createFakeElectron();
    const createServer = vi.fn((o: ProxyServerOptions) => createProxyServer(o));
    handle = await start(electron, { isAlive: (pid) => pid === other.pid, createServer });
    const info = (await electron.ipc.invoke(TRAY_CHANNELS.setSettings, {
      proxyPort: 45_999,
    })) as TrayInfo;
    expect(createServer).not.toHaveBeenCalled();
    expect(info).toMatchObject({ proxyUrl: other.url, proxyOwned: false });
    expect(info.settings.proxyPort).toBe(45_999);
    expect(JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'))).toEqual(other);
  });

  it('moves its own proxy to a new port when the setting changes', async () => {
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    const electron = createFakeElectron();
    handle = await start(electron);
    const h = handle!;
    const before = h.info().proxyUrl!;
    // Find a free port, release it, and ask for it.
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const wanted = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const info = (await electron.ipc.invoke(TRAY_CHANNELS.setSettings, {
      proxyPort: wanted,
    })) as TrayInfo;
    expect(info.proxyUrl).toBe(`http://127.0.0.1:${wanted}`);
    expect(info.proxyPort).toBe(wanted);
    await expect(fetch(`${before}/iron/health`)).rejects.toThrow();
    expect((await fetch(`${info.proxyUrl}/iron/health`)).status).toBe(200);
    const d = JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'));
    expect(d.url).toBe(info.proxyUrl);
  });

  it('starts its own proxy once when the port changes after the shared one has gone', async () => {
    const other = { url: 'http://127.0.0.1:45682', token: 'other-token', pid: 999_994 };
    await writeFile(join(dir, 'proxy.json'), JSON.stringify(other));
    const alive = new Set([other.pid]);
    // Every proxy.json this app writes follows one successful listen.
    const listened: string[] = [];
    const createServer = (o: ProxyServerOptions): ProxyServer => {
      const s = createProxyServer(o);
      const listen = s.listen.bind(s);
      s.listen = async () => {
        const info = await listen();
        listened.push(info.url);
        return info;
      };
      return s;
    };
    const electron = createFakeElectron();
    handle = await start(electron, {
      isAlive: (pid) => alive.has(pid),
      createServer,
      watch: () => ({ close() {} }),
    });
    expect(handle!.info()).toMatchObject({ proxyUrl: other.url, proxyOwned: false });

    // The shared proxy's process is gone (left proxy.json behind), then the port changes.
    alive.delete(other.pid);
    const probe = createNetServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const wanted = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const info = (await electron.ipc.invoke(TRAY_CHANNELS.setSettings, {
      proxyPort: wanted,
    })) as TrayInfo;

    expect(info).toMatchObject({
      proxyUrl: `http://127.0.0.1:${wanted}`,
      proxyPort: wanted,
      proxyOwned: true,
    });
    expect(listened).toEqual([`http://127.0.0.1:${wanted}`]);
    const d = JSON.parse(await readFile(join(dir, 'proxy.json'), 'utf8'));
    expect(d).toMatchObject({ url: info.proxyUrl, pid: process.pid });
    expect((await fetch(`${info.proxyUrl}/iron/health`)).status).toBe(200);
  });

  it('relabels the menu when a rest ends, with one timer and no polling', async () => {
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    let now = Date.parse('2026-09-24T12:00:00Z');
    const pending: Array<{ fn: () => void; at: number; id: number }> = [];
    let seq = 0;
    const timers = {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const t = { fn, at: now + ms, id: ++seq };
        pending.push(t);
        return t.id;
      },
      clearTimeout: (id: unknown) => {
        const i = pending.findIndex((t) => t.id === id);
        if (i >= 0) pending.splice(i, 1);
      },
    };
    /** Advance the fake clock, running what falls due. */
    const advance = async (ms: number) => {
      now += ms;
      for (;;) {
        const due = pending.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        pending.splice(pending.indexOf(due), 1);
        due.fn();
        await handle!.refresh();
      }
    };
    const electron = createFakeElectron();
    handle = await start(electron, { timers });
    const h = handle!;
    const p = await h.iron.createProfile({
      title: 'Work Claude Max',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'sk-x',
    });
    const st = await h.iron.router.state(p.id);
    await h.iron.states.put({
      ...st,
      status: 'parked',
      parkedUntil: '2026-09-24T15:40:00Z',
    });
    await advance(0);
    await h.refresh();
    expect(findItem(h.menu(), `account-${p.id}`)?.label).toBe(
      'Work Claude Max (parked until 3:40 PM)',
    );
    expect(electron.trays[0]!.tooltip).toBe('Iron-Proxy: Claude: no account ready');
    // Exactly one timer is waiting, for the end of the rest (plus a second).
    expect(pending.map((t) => t.at)).toEqual([Date.parse('2026-09-24T15:40:01Z')]);

    await advance(3 * 3_600_000 + 41 * 60_000);
    expect(findItem(h.menu(), `account-${p.id}`)?.label).toBe('Work Claude Max');
    expect(electron.trays[0]!.tooltip).toBe('Iron-Proxy: Claude on "Work Claude Max"');
    expect(pending).toEqual([]);
  });

  it('follows accounts and parks the CLI writes to the shared data directory', async () => {
    await saveSettings(dir, { ...defaultSettings(), proxyPort: await takenPort() });
    let changed: ((name?: string) => void) | undefined;
    let closed = false;
    const electron = createFakeElectron();
    handle = await start(electron, {
      watch: (watched, onChange) => {
        expect(watched).toBe(dir);
        changed = onChange;
        return { close: () => void (closed = true) };
      },
    });
    const h = handle!;
    await h.dispatch({ type: 'open-window' });
    const win = electron.windows[0]!;
    win.close();

    // Another process (the CLI) adds an account to the same directory.
    const cli = createIronProxy({ dataDir: dir });
    const added = await cli.createProfile({
      title: 'Added From CLI',
      provider: 'openai',
      lane: 'api-key',
      apiKeySecret: 'sk-cli',
    });
    await cli.close();
    // Unrelated files in the directory do not rebuild anything.
    changed!('other.txt');
    await new Promise((r) => setTimeout(r, 50));
    expect(electron.trays[0]!.tooltip).toBe('Iron-Proxy: no accounts yet');
    changed!('profiles.json');
    await vi.waitFor(() =>
      expect(electron.trays[0]!.tooltip).toBe('Iron-Proxy: ChatGPT on "Added From CLI"'),
    );
    expect(findItem(h.menu(), `account-${added.id}`)?.checked).toBe(true);
    // The hidden window reloads once when it is shown again, so the switcher sees it too.
    await h.dispatch({ type: 'open-window' });
    expect(win.reloads).toBe(1);
    await h.dispatch({ type: 'open-window' });
    expect(win.reloads).toBe(1);

    // Let the tray catch up with everything the CLI wrote (its last state.json
    // flush can land after the rebuild above read the file), and consume that
    // reload, so what follows measures only the tray's own writes.
    changed!('state.json');
    await h.refresh();
    await h.dispatch({ type: 'open-window' });
    const baseline = win.reloads;
    expect(baseline).toBeGreaterThanOrEqual(1);

    // The tray's own writes fire the watcher too, but are not another process's
    // changes: the hidden window is not reloaded for them.
    win.close();
    const own = await h.iron.createProfile({
      title: 'Own Write',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'sk-own',
    });
    await h.iron.refreshStatus(own.id);
    await (h.iron.states as unknown as { flush(): Promise<void> }).flush();
    changed!('profiles.json');
    changed!('state.json');
    await h.refresh();
    expect(findItem(h.menu(), `account-${own.id}`)).toBeDefined();
    await h.dispatch({ type: 'open-window' });
    expect(win.reloads).toBe(baseline);
    // A park the CLI records afterwards is another process's change again.
    win.close();
    const cli2 = createIronProxy({ dataDir: dir });
    const st2 = await cli2.router.state(added.id);
    await cli2.states.put({ ...st2, status: 'parked', parkedUntil: '2999-01-01T00:00:00Z' });
    await cli2.close();
    changed!('state.json');
    await h.refresh();
    expect(findItem(h.menu(), `account-${added.id}`)?.label).toMatch(/parked/);
    await h.dispatch({ type: 'open-window' });
    expect(win.reloads).toBe(baseline + 1);

    // And the tray's own changes keep what the CLI wrote.
    const mine = await h.iron.createProfile({
      title: 'Added In Tray',
      provider: 'openai',
      lane: 'api-key',
      apiKeySecret: 'sk-tray',
    });
    const status = createIronProxy({ dataDir: dir });
    expect((await status.listProfiles()).map((p) => p.id).sort()).toEqual(
      [added.id, own.id, mine.id].sort(),
    );
    await status.close();

    await h.shutdown();
    handle = undefined;
    expect(closed).toBe(true);
  });
});
