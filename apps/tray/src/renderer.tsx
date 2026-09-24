import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getIronClient } from '@iron-proxy/electron/renderer';
import type { TrayBridge } from './logic/channels.js';
import { TrayWindow } from './ui/TrayWindow.js';

declare global {
  interface Window {
    ironTray?: TrayBridge;
  }
}

const tray = window.ironTray;
if (!tray) throw new Error('window.ironTray is missing: the preload script did not run.');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TrayWindow client={getIronClient()} tray={tray} />
  </StrictMode>,
);
