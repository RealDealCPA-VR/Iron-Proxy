import { contextBridge, ipcRenderer } from 'electron';
import { exposeIronProxy } from '@iron-proxy/electron/preload';
import type { StreamEvent } from '@iron-proxy/core';

// window.ironProxy: the full IronClient, straight from the main process.
exposeIronProxy({ contextBridge, ipcRenderer });

// window.example: the two app-specific channels the demo uses.
contextBridge.exposeInMainWorld('example', {
  setSelected(id: string | undefined) {
    ipcRenderer.send('example:selected', id);
  },
  chat(prompt: string, provider: string, onEvent: (ev: StreamEvent) => void): Promise<void> {
    const handler = (_e: unknown, ev: StreamEvent) => onEvent(ev);
    ipcRenderer.on('example:chat-event', handler);
    return ipcRenderer
      .invoke('example:chat', prompt, provider)
      .finally(() => ipcRenderer.removeListener('example:chat-event', handler));
  },
});
