// Electron main process of the Iron-Proxy tray app. Everything testable lives in
// app.ts and logic/; this file only hands the real Electron modules over.
import { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, Tray } from 'electron';
import { join } from 'node:path';
import { startTrayApp } from './app.js';

startTrayApp({
  electron: { app, BrowserWindow, clipboard, ipcMain, Menu, Notification, Tray },
  // The bundle is out/main.cjs; the icons sit next to out/ in assets/.
  outDir: __dirname,
  assetsDir: join(__dirname, '..', 'assets'),
}).catch((err: unknown) => {
  console.error(`[iron-proxy tray] ${err instanceof Error ? err.message : String(err)}`);
  app.exit(1);
});
