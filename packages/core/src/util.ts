import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProviderId } from './types.js';

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Sortable, URL-safe id: 10 chars of ms timestamp + 12 random chars. */
export function newId(prefix = ''): string {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = randomBytes(9).toString('base64url').slice(0, 12);
  return prefix ? `${prefix}_${t}${r}` : `${t}${r}`;
}

export function isoNow(clock: Clock = systemClock): string {
  return new Date(clock.now()).toISOString();
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse durations like "6m0s", "1.5s", "250ms", "2h", "1h30m", "45", "45 seconds",
 * "resets in 3 hours 20 minutes". Returns milliseconds or undefined.
 */
export function parseDurationMs(input: string | undefined | null): number | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s) * 1000; // bare seconds (Retry-After)
  const re =
    /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)(?![a-z])/g;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2] ?? '';
    if (unit.startsWith('ms') || unit.startsWith('milli')) total += n;
    else if (unit.startsWith('s')) total += n * 1000;
    else if (unit.startsWith('m')) total += n * 60_000;
    else if (unit.startsWith('h')) total += n * 3_600_000;
    else if (unit.startsWith('d')) total += n * 86_400_000;
  }
  return matched ? Math.round(total) : undefined;
}

/**
 * Parse an absolute reset instant from a header or message.
 * Accepts ISO 8601, RFC 7231 dates, unix seconds, unix milliseconds, and
 * clock phrases like "3pm", "3:30 PM", "15:30" (interpreted as the next such
 * time from `now`, in local time).
 */
export function parseResetAt(
  input: string | undefined | null,
  now: number = Date.now(),
): string | undefined {
  if (!input) return undefined;
  const s = input.trim();
  if (!s) return undefined;

  if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{12,13}$/.test(s)) return new Date(Number(s)).toISOString();

  const asDate = new Date(s);
  if (!Number.isNaN(asDate.getTime()) && /\d{4}/.test(s)) return asDate.toISOString();

  const clock = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(s);
  if (clock && (clock[2] !== undefined || clock[3] !== undefined)) {
    let h = Number(clock[1]);
    const min = clock[2] ? Number(clock[2]) : 0;
    const ap = clock[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return undefined;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  return undefined;
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Write via a temp file then rename, so a crash never leaves a half-written file. */
export async function writeJsonFileAtomic(
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode });
  try {
    await chmod(tmp, mode);
  } catch {
    /* Windows ignores POSIX modes */
  }
  // Windows refuses a rename for a moment while another process has the target
  // open (a reader, an antivirus scan): retry briefly before giving up.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        await rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 10 + attempt * 5));
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Redact anything that looks like a key or bearer token from text bound for logs or UI. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{10,}/g, '$1…')
    .replace(/(AIza[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{10,}/g, '$1…')
    .replace(/(xai-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{10,}/g, '$1…')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1…')
    .replace(/(eyJ[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{20,}\.[A-Za-z0-9._-]+/g, '$1…');
}

export function inferProvider(model: string | undefined): ProviderId | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gemini') || m.startsWith('models/gemini')) return 'google';
  if (m.startsWith('grok')) return 'xai';
  if (/^(gpt|o\d|chatgpt|codex|text-embedding|davinci)/.test(m)) return 'openai';
  return undefined;
}
