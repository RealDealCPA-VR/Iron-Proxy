import type { IronClient } from '@iron-proxy/core';

declare global {
  interface Window {
    ironProxy?: IronClient;
  }
}

/**
 * Renderer-side accessor. Throws a clear error when the preload did not run
 * `exposeIronProxy`, which is the usual cause of "window.ironProxy is undefined".
 */
export function getIronClient(globalName = 'ironProxy'): IronClient {
  const w = globalThis as unknown as Record<string, unknown>;
  const client = w[globalName] as IronClient | undefined;
  if (!client || typeof client.listProfiles !== 'function') {
    throw new Error(
      `window.${globalName} is not available. Add exposeIronProxy({ contextBridge, ipcRenderer }) from "@iron-proxy/electron/preload" to your preload script and load it with webPreferences.preload.`,
    );
  }
  return client;
}

export type { IronClient };
