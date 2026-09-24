import type { LoginCommandInfo, Profile, ProviderId } from '@iron-proxy/core';

export type Grouped = Array<{ provider: ProviderId; profiles: Profile[] }>;

/** Group profiles by provider, each group sorted by failover order. */
export function groupByProvider(profiles: Profile[], providerOrder?: ProviderId[]): Grouped {
  const map = new Map<ProviderId, Profile[]>();
  for (const p of profiles) {
    const list = map.get(p.provider) ?? [];
    list.push(p);
    map.set(p.provider, list);
  }
  const keys = [...map.keys()];
  if (providerOrder) {
    keys.sort((a, b) => {
      const ia = providerOrder.indexOf(a);
      const ib = providerOrder.indexOf(b);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b);
    });
  } else keys.sort();
  return keys.map((provider) => ({
    provider,
    profiles: [...map.get(provider)!].sort((a, b) => a.order - b.order),
  }));
}

/** "12:34", "1h 05m", "2d 03h" for a remaining span in ms. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86_400) {
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3600);
    return `${d}d ${String(h).padStart(2, '0')}h`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** Local clock time, e.g. "3:40 PM", for an ISO instant. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString();
  }
}

const INHERITED_ENV = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'SHELL',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

function quote(s: string, win: boolean): string {
  if (/^[\w./:\\-]+$/.test(s)) return s;
  return win ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One pasteable line for the login command, showing only the vars that matter (the isolated home). */
export function formatLoginCommand(
  cmd: LoginCommandInfo,
  platform: 'win32' | 'posix' = detectPlatform(),
): string {
  const win = platform === 'win32';
  const vars = Object.entries(cmd.env).filter(([k]) => !INHERITED_ENV.has(k));
  const envPart = vars
    .map(([k, v]) => (win ? `set "${k}=${v}" && ` : `${k}=${quote(v, false)} `))
    .join('');
  const bin = quote(cmd.binary, win);
  const args = cmd.args.map((a) => quote(a === '' ? '' : a, win)).map((a) => (a === '' ? '""' : a));
  return `${envPart}${bin}${args.length ? ' ' + args.join(' ') : ''}`.trim();
}

function detectPlatform(): 'win32' | 'posix' {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const ua =
    (nav?.userAgent ?? '') + ' ' + ((nav as { platform?: string } | undefined)?.platform ?? '');
  return /win/i.test(ua) && !/darwin|mac/i.test(ua) ? 'win32' : 'posix';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export const PROVIDER_SHORT: Record<ProviderId, string> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  google: 'Gemini',
  xai: 'Grok',
  'openai-compatible': 'Custom',
};

export function suggestTitle(provider: ProviderId, existing: Profile[]): string {
  const base = PROVIDER_SHORT[provider];
  const taken = new Set(existing.filter((p) => p.provider === provider).map((p) => p.title));
  for (const prefix of ['Personal', 'Work', 'Second', 'Third', 'Fourth']) {
    const t = `${prefix} ${base}`;
    if (!taken.has(t)) return t;
  }
  return `${base} ${existing.length + 1}`;
}

export interface ClientError {
  message: string;
  code?: string;
  retryable?: boolean;
  /** What the user should do next, when the library said. */
  hint?: string;
}

export function toClientError(err: unknown): ClientError {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; retryable?: unknown; hint?: unknown };
    return {
      message: typeof e.message === 'string' ? e.message : String(err),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.retryable === 'boolean' ? { retryable: e.retryable } : {}),
      ...(typeof e.hint === 'string' && e.hint ? { hint: e.hint } : {}),
    };
  }
  return { message: String(err) };
}
