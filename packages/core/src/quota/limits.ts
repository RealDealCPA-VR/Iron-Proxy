import type {
  AccountWindow,
  ExternalRateLimits,
  PlanSource,
  ProfileState,
  ProviderId,
} from '../types.js';
import type { HeaderGetter } from './detect.js';

/**
 * Claude's subscription usage windows, read from the response headers exactly as
 * Claude Code reads them itself (verified in the code bundled with Claude Code
 * 2.1.306, 2026-10-21; the headers are not in Anthropic's public API docs):
 *
 * - `anthropic-ratelimit-unified-<w>-utilization`: a 0..1 fraction of the window
 *   used (Claude Code shows `Math.round(u * 100)` percent);
 * - `anthropic-ratelimit-unified-<w>-reset`: unix seconds (`Math.round(Number(v))`);
 * - `<w>` = `5h` (Claude Code's `five_hour`, 18000 s) and `7d` (`seven_day`, 604800 s).
 *
 * Claude Code also reads `7d_oi` and `overage` windows; their lengths are not stated
 * anywhere Iron-Proxy can check, so they are not read.
 */
export const CLAUDE_USAGE_WINDOWS: ReadonlyArray<{ kind: string; windowMins: number }> = [
  { kind: '5h', windowMins: 300 },
  { kind: '7d', windowMins: 10_080 },
];

/** Prefix of every Claude usage-window header Iron-Proxy reads. */
export const CLAUDE_WINDOW_HEADER_PREFIX = 'anthropic-ratelimit-unified-';

/**
 * A reading above this is not the shape Iron-Proxy verified (a 0..1 fraction, or a
 * Codex percentage), so the window is left absent rather than shown wrong.
 */
export const MAX_USED_PERCENT = 150;

/** How old a host's `observedAt` may be; anything outside is replaced by "now". */
const OBSERVED_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** How far ahead of this clock a host's `observedAt` may be (clock skew). */
const OBSERVED_MAX_SKEW_MS = 60_000;

/** What a host's report taught about an account. */
export interface LearnedLimits {
  plan?: { plan: string; source: PlanSource; at: string };
  windows: AccountWindow[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * A plan name as a vendor spells it (`max`, `pro`, `plus`, `team`,
 * `edu_plus`, …), lowercased; undefined for anything else (an email, a sentence,
 * `unknown`, a non-string). Never guessed.
 */
export function normalizePlan(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(v) || v === 'unknown') return undefined;
  return v;
}

/** Unix seconds as an ISO instant, for a number that plausibly is unix seconds. */
export function unixSecondsToIso(n: unknown): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1e9 || n >= 1e11) return undefined;
  return new Date(Math.round(n * 1000)).toISOString();
}

/**
 * A reset instant from a header value, in ms: unix seconds (what Anthropic's
 * `anthropic-ratelimit-unified-*-reset` headers carry), otherwise whatever
 * `Date` parses (RFC 3339, as the documented `anthropic-ratelimit-*-reset` headers
 * carry). NaN when neither.
 */
export function headerInstantMs(value: string | null | undefined): number {
  if (value === null || value === undefined) return NaN;
  const t = value.trim();
  if (/^\d{9,10}(?:\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  return new Date(value).getTime();
}

function headerNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const t = value.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Claude's usage windows from the `anthropic-ratelimit-unified-*` headers (see
 * CLAUDE_USAGE_WINDOWS). A window whose utilization header is missing or unreadable
 * is absent; its reset is left out when that header is unreadable.
 */
export function windowsFromHeaders(
  provider: ProviderId,
  headers: HeaderGetter,
  now: number,
): AccountWindow[] {
  if (provider !== 'anthropic') return [];
  const at = new Date(now).toISOString();
  const out: AccountWindow[] = [];
  for (const w of CLAUDE_USAGE_WINDOWS) {
    const u = headerNumber(headers(`${CLAUDE_WINDOW_HEADER_PREFIX}${w.kind}-utilization`));
    if (u === undefined || u < 0) continue;
    const usedPercent = round1(u * 100);
    if (usedPercent > MAX_USED_PERCENT) continue;
    const resetMs = headerInstantMs(headers(`${CLAUDE_WINDOW_HEADER_PREFIX}${w.kind}-reset`));
    out.push({
      kind: w.kind,
      usedPercent,
      windowMins: w.windowMins,
      ...(Number.isFinite(resetMs) ? { resetsAt: new Date(resetMs).toISOString() } : {}),
      source: 'headers',
      at,
    });
  }
  return out;
}

/** When a host read its snapshot: its `observedAt` when plausible, else now. */
function observedAt(value: unknown, now: number): string {
  const iso = unixSecondsToIso(value);
  if (iso) {
    const t = Date.parse(iso);
    if (t <= now + OBSERVED_MAX_SKEW_MS && t >= now - OBSERVED_MAX_AGE_MS) return iso;
  }
  return new Date(now).toISOString();
}

/**
 * What a Codex rate-limit snapshot says: the plan (`planType`) and the `primary` /
 * `secondary` windows. Only those fields are read; a window whose `usedPercent` is
 * not a number in 0..150 is absent, and an unreadable `windowDurationMins` or
 * `resetsAt` is left out of its window.
 */
export function limitsFromRateLimits(rl: ExternalRateLimits, now: number): LearnedLimits {
  const at = observedAt(rl.observedAt, now);
  const out: LearnedLimits = { windows: [] };
  const plan = normalizePlan(rl.planType);
  if (plan) out.plan = { plan, source: 'rate-limits', at };
  for (const kind of ['primary', 'secondary'] as const) {
    const w: unknown = rl[kind];
    if (!isObject(w)) continue;
    const used = w.usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    if (used < 0 || used > MAX_USED_PERCENT) continue;
    const mins = w.windowDurationMins;
    const resetsAt = unixSecondsToIso(w.resetsAt);
    out.windows.push({
      kind,
      usedPercent: round1(used),
      ...(typeof mins === 'number' && Number.isFinite(mins) && mins > 0
        ? { windowMins: Math.round(mins) }
        : {}),
      ...(resetsAt ? { resetsAt } : {}),
      source: 'rate-limits',
      at,
    });
  }
  return out;
}

/** Everything one report (headers and/or a snapshot) teaches about the account. */
export function learnLimits(
  provider: ProviderId,
  input: { headers?: HeaderGetter; rateLimits?: ExternalRateLimits },
  now: number,
): LearnedLimits {
  const out: LearnedLimits = {
    windows: input.headers ? windowsFromHeaders(provider, input.headers, now) : [],
  };
  if (input.rateLimits) {
    const rl = limitsFromRateLimits(input.rateLimits, now);
    if (rl.plan) out.plan = rl.plan;
    out.windows.push(...rl.windows);
  }
  return out;
}

/** True when a report taught nothing (no plan, no window). */
export function learnedNothing(l: LearnedLimits): boolean {
  return !l.plan && !l.windows.length;
}

/** The windows whose reset is still ahead (or unknown). */
export function liveWindows(windows: readonly AccountWindow[], now: number): AccountWindow[] {
  return windows.filter((w) => w.resetsAt === undefined || Date.parse(w.resetsAt) > now);
}

/**
 * The latest reading per window kind: an incoming window replaces the stored one
 * of the same kind unless the stored one was read later. Windows whose reset has
 * passed are dropped.
 */
export function mergeWindows(
  current: readonly AccountWindow[] | undefined,
  incoming: readonly AccountWindow[],
  now: number,
): AccountWindow[] {
  const byKind = new Map<string, AccountWindow>();
  for (const w of current ?? []) byKind.set(w.kind, w);
  for (const w of incoming) {
    const old = byKind.get(w.kind);
    if (!old || !(Date.parse(old.at) > Date.parse(w.at))) byKind.set(w.kind, w);
  }
  return liveWindows([...byKind.values()], now);
}

/**
 * Store what a report taught on a state (mutated in place). The plan is replaced
 * unless the stored one was read later. Returns whether anything changed.
 */
export function applyLimits(st: ProfileState, learned: LearnedLimits, now: number): boolean {
  let changed = false;
  const p = learned.plan;
  if (p && !(st.planAt !== undefined && Date.parse(st.planAt) > Date.parse(p.at))) {
    if (st.plan !== p.plan || st.planSource !== p.source || st.planAt !== p.at) {
      st.plan = p.plan;
      st.planSource = p.source;
      st.planAt = p.at;
      changed = true;
    }
  }
  const merged = mergeWindows(st.windows, learned.windows, now);
  if (JSON.stringify(merged) !== JSON.stringify(st.windows ?? [])) {
    if (merged.length) st.windows = merged;
    else delete st.windows;
    changed = true;
  }
  return changed;
}

/**
 * The reset of the windows a report says are used up (100% or more), the latest
 * of them: the account is usable again only once all of them reset. Undefined
 * when no window is used up or none of those has a reset ahead.
 */
export function exhaustedResetAt(
  windows: readonly AccountWindow[],
  now: number,
): string | undefined {
  let best: number | undefined;
  for (const w of windows) {
    if (w.usedPercent < 100 || w.resetsAt === undefined) continue;
    const t = Date.parse(w.resetsAt);
    if (t > now && (best === undefined || t > best)) best = t;
  }
  return best !== undefined ? new Date(best).toISOString() : undefined;
}
