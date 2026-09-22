import { createContext, useContext } from 'react';
import type { LoginCommandInfo, ProviderId } from '@iron-proxy/core';
import type { Labels } from '../labels.js';
import type { IronProxyView } from '../hooks/useIronProxy.js';

export interface SwitcherContextValue {
  labels: Labels;
  view: IronProxyView;
  providerName(id: ProviderId): string;
  onOpenTerminal?: ((cmd: LoginCommandInfo) => void | Promise<void>) | undefined;
  compact: boolean;
}

export const SwitcherContext = createContext<SwitcherContextValue | null>(null);

export function useSwitcher(): SwitcherContextValue {
  const ctx = useContext(SwitcherContext);
  if (!ctx)
    throw new Error('Iron-Proxy switcher components must be rendered inside <AccountSwitcher>.');
  return ctx;
}
