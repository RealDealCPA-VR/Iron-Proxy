import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  type IpcMainInvokeEvent,
} from 'electron';
import { join } from 'node:path';
import type { ProviderId, UnifiedRequest } from '@iron-proxy/core';
import {
  createElectronIronProxy,
  createNotifier,
  installIronProxy,
  openLoginTerminal,
} from '@iron-proxy/electron';

let selectedProfileId: string | undefined;

async function main() {
  await app.whenReady();

  // 1. The engine. Data under userData/iron-proxy, vault key wrapped by safeStorage.
  const iron = createElectronIronProxy({ app, safeStorage });

  // 2. One IPC dispatcher for the whole IronClient surface + event forwarding.
  const installation = installIronProxy({ ipcMain, iron });

  // 2b. Desktop notifications: an automatic switch, a resting account, every
  //     account of a provider resting, a sign-in that finished or failed.
  const notifier = createNotifier({
    iron,
    Notification,
    onError: (err) => console.error('[iron-proxy notifier]', err),
  });
  // Quitting any way (Cmd+Q, OS logout) stops it; dispose() is safe to call twice.
  app.on('before-quit', () => notifier.dispose());

  // 3. App-specific channels: the renderer tells us which profile is selected,
  //    and the chat box streams through iron.stream.
  ipcMain.on('example:selected', (_e, id: string | undefined) => {
    selectedProfileId = id;
  });
  ipcMain.handle(
    'example:chat',
    async (event: IpcMainInvokeEvent, prompt: string, provider: string) => {
      const req: UnifiedRequest = {
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      };
      for await (const ev of iron.stream(req, { provider: provider as ProviderId })) {
        if (!event.sender.isDestroyed()) event.sender.send('example:chat-event', ev);
      }
    },
  );

  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    title: 'Iron-Proxy example host',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      {
        label: 'Accounts',
        submenu: [
          {
            label: 'Open login in terminal (selected account)',
            click: async () => {
              if (!selectedProfileId) return;
              const cmd = await iron.loginCommand(selectedProfileId);
              await openLoginTerminal(cmd);
            },
          },
          { label: 'Re-check all accounts', click: () => void iron.refreshStatus() },
        ],
      },
      { role: 'viewMenu' },
    ]),
  );

  await win.loadFile(join(__dirname, 'index.html'));

  app.on('window-all-closed', async () => {
    notifier.dispose();
    installation.dispose();
    await iron.close();
    app.quit();
  });
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
