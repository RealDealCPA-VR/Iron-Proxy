import { useEffect } from 'react';
import { css } from './styles.generated.js';

const STYLE_ID = 'iron-proxy-switcher-styles';

/** Adds the stylesheet to <head> once. Safe to call many times and on the server (no-op). */
export function injectStyles(
  target: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  if (!target || target.getElementById(STYLE_ID)) return;
  const style = target.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-iron-proxy', 'switcher');
  style.textContent = css;
  target.head.appendChild(style);
}

export function useInjectedStyles(enabled: boolean): void {
  useEffect(() => {
    if (enabled) injectStyles();
  }, [enabled]);
}

export { css as switcherCss };
