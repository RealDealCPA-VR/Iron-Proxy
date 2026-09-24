import type {
  ProfileUsageHistory,
  UsageEstimate,
  UsageReport,
  UsageSampleRecord,
  UsageWindow,
  UsageWindowTotals,
} from '../types.js';
import { USAGE_WINDOWS } from '../types.js';

export const USAGE_WINDOW_MS: Readonly<Record<UsageWindow, number>> = {
  '1h': 60 * 60_000,
  '5h': 5 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

/** Without a reset time, samples from the last hour count as the current window. */
export const SAMPLE_WINDOW_WITHOUT_RESET_MS = 60 * 60_000;
/** Fewer samples than this never produce an estimate. */
export const ESTIMATE_MIN_SAMPLES = 3;
/** Medium confidence needs this many samples... */
export const ESTIMATE_MEDIUM_SAMPLES = 6;
/** ...spanning at least this long. */
export const ESTIMATE_MEDIUM_SPAN_MS = 10 * 60_000;

function time(iso: string | undefined): number {
  if (iso === undefined) return NaN;
  return Date.parse(iso);
}

/**
 * The samples that describe the current window, oldest first: those sharing the
 * latest sample's `resetAt` (while that reset is still ahead), or, when the latest
 * has no `resetAt`, those without one from the last hour. Empty when the latest
 * sample is stale.
 */
export function currentWindowSamples(
  samples: readonly UsageSampleRecord[],
  now: number,
): UsageSampleRecord[] {
  const seen = samples
    .filter((s) => Number.isFinite(s.utilisation) && time(s.at) <= now)
    .sort((a, b) => time(a.at) - time(b.at));
  const latest = seen[seen.length - 1];
  if (!latest) return [];
  if (latest.resetAt !== undefined) {
    const reset = time(latest.resetAt);
    if (!(reset > now)) return [];
    return seen.filter((s) => s.resetAt !== undefined && time(s.resetAt) === reset);
  }
  const since = now - SAMPLE_WINDOW_WITHOUT_RESET_MS;
  return seen.filter((s) => s.resetAt === undefined && time(s.at) >= since);
}

/**
 * Minutes until the window is full at the recent pace, from a least-squares line
 * through the current window's utilisation samples.
 *
 * Undefined with fewer than three samples, or when the trend is flat or falling:
 * no estimate is ever invented. `minutesLeft = (1 - latest) / slopePerMinute`,
 * capped at the minutes until `resetAt` when known.
 */
export function estimateTimeLeft(
  samples: readonly UsageSampleRecord[],
  now: number,
): UsageEstimate | undefined {
  const win = currentWindowSamples(samples, now);
  if (win.length < ESTIMATE_MIN_SAMPLES) return undefined;
  const t0 = time(win[0]!.at);
  const xs = win.map((s) => (time(s.at) - t0) / 60_000);
  const ys = win.map((s) => s.utilisation);
  const n = win.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  if (!(sxx > 0)) return undefined; // every sample at one instant: no trend
  const slope = sxy / sxx;
  if (!(slope > 0) || !Number.isFinite(slope)) return undefined;
  const latest = win[n - 1]!;
  let minutes = Math.max(0, 1 - latest.utilisation) / slope;
  const reset = time(latest.resetAt);
  if (Number.isFinite(reset)) minutes = Math.min(minutes, Math.max(0, (reset - now) / 60_000));
  const span = time(latest.at) - t0;
  return {
    minutesLeft: Math.round(minutes),
    basis: 'utilisation-trend',
    confidence: n >= ESTIMATE_MEDIUM_SAMPLES && span >= ESTIMATE_MEDIUM_SPAN_MS ? 'medium' : 'low',
  };
}

/** One profile's report from its history at `now`. */
export function buildUsageReport(
  profileId: string,
  history: ProfileUsageHistory,
  now: number,
): UsageReport {
  const windows = {} as Record<UsageWindow, UsageWindowTotals>;
  for (const w of USAGE_WINDOWS) {
    const since = now - USAGE_WINDOW_MS[w];
    const totals: UsageWindowTotals = { requests: 0, inputTokens: 0, outputTokens: 0 };
    for (const r of history.requests) {
      const t = time(r.at);
      if (!(t >= since && t <= now)) continue;
      totals.requests++;
      totals.inputTokens += r.inputTokens ?? 0;
      totals.outputTokens += r.outputTokens ?? 0;
    }
    windows[w] = totals;
  }
  const weekAgo = now - USAGE_WINDOW_MS['7d'];
  let parks7d = 0;
  let lastParkedAt: string | undefined;
  for (const p of history.parks) {
    const t = time(p.at);
    if (!(t <= now)) continue;
    if (t >= weekAgo) parks7d++;
    if (lastParkedAt === undefined || t > time(lastParkedAt)) lastParkedAt = p.at;
  }
  const report: UsageReport = { profileId, windows, parks7d };
  if (lastParkedAt !== undefined) report.lastParkedAt = lastParkedAt;
  const current = currentWindowSamples(history.samples, now);
  const latest = current[current.length - 1];
  if (latest) {
    report.utilisation = latest.utilisation;
    if (latest.resetAt !== undefined) report.resetAt = latest.resetAt;
  }
  const estimate = estimateTimeLeft(history.samples, now);
  if (estimate) report.estimate = estimate;
  return report;
}
