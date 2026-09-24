import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LoginCommandInfo } from '@iron-proxy/core';
import { exposeIronProxy } from '@iron-proxy/electron/preload';
import { TRAY_CHANNELS, type TrayBridge, type TrayInfo } from './logic/channels.js';
import type { TraySettingsPatch } from './logic/settings.js';

// window.ironProxy: the full IronClient, served by the main process.
exposeIronProxy({ contextBridge, ipcRenderer });

// window.ironTray: the tray's own few channels (proxy URL, settings, terminal login, copy).
const bridge: TrayBridge = {
  info: () => ipcRenderer.invoke(TRAY_CHANNELS.info) as Promise<TrayInfo>,
  setSettings: (patch: TraySettingsPatch) =>
    ipcRenderer.invoke(TRAY_CHANNELS.setSettings, patch) as Promise<TrayInfo>,
  openTerminal: async (cmd: LoginCommandInfo) => {
    await ipcRenderer.invoke(TRAY_CHANNELS.openTerminal, cmd);
  },
  copy: async (text: string) => {
    await ipcRenderer.invoke(TRAY_CHANNELS.copy, text);
  },
  onChanged(listener: (info: TrayInfo) => void) {
    const handler = (_e: IpcRendererEvent, info: TrayInfo) => listener(info);
    ipcRenderer.on(TRAY_CHANNELS.changed, handler);
    return () => {
      ipcRenderer.removeListener(TRAY_CHANNELS.changed, handler);
    };
  },
};
contextBridge.exposeInMainWorld('ironTray', bridge);
