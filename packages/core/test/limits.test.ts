import { describe, expect, it } from 'vitest';
import { detectFromHttp, headersFrom } from '../src/quota/detect.js';
import {
  applyLimits,
  exhaustedResetAt,
  headerInstantMs,
  learnLimits,
  limitsFromRateLimits,
  mergeWindows,
  normalizePlan,
  windowsFromHeaders,
} from '../src/quota/limits.js';
import { claudeSpec, codexSpec } from '../src/adapters/cli/specs.js';
import type { AccountWindow, ProfileState } from '../src/types.js';

/**
 * Plan and usage windows from what a host reports: Claude's
 * `anthropic-ratelimit-unified-*` headers and Codex's rate-limit snapshot.
 */

const now = Date.parse('2026-10-21T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const secs = (ms: number) => Math.floor(ms / 1000);

describe('windowsFromHeaders (Claude)', () => {
  const reset5h = now + 2 * 3_600_000;
  const reset7d = now + 3 * 86_400_000;
  const claude = headersFrom({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.38',
    'anthropic-ratelimit-unified-5h-reset': String(secs(reset5h)),
    'anthropic-ratelimit-unified-7d-utilization': '0.9',
    'anthropic-ratelimit-unified-7d-reset': String(secs(reset7d)),
  });

  it('reads the 5h and 7d windows: a 0..1 fraction as percent, the reset as unix seconds', () => {
    expect(windowsFromHeaders('anthropic', claude, now)).toEqual([
      {
        kind: '5h',
        usedPercent: 38,
        windowMins: 300,
        resetsAt: iso(secs(reset5h) * 1000),
        source: 'headers',
        at: iso(now),
      },
      {
        kind: '7d',
        usedPercent: 90,
        windowMins: 10_080,
        resetsAt: iso(secs(reset7d) * 1000),
        source: 'headers',
        at: iso(now),
      },
    ]);
  });

  it('rounds to one decimal, never a float tail', () => {
    const h = headersFrom({ 'anthropic-ratelimit-unified-5h-utilization': '0.29' });
    expect(windowsFromHeaders('anthropic', h, now)[0]?.usedPercent).toBe(29);
    const h2 = headersFrom({ 'anthropic-ratelimit-unified-5h-utilization': '0.12345' });
    expect(windowsFromHeaders('anthropic', h2, now)[0]?.usedPercent).toBe(12.3);
  });

  it('leaves a window absent when its utilization is missing or unreadable, never invented', () => {
    for (const u of [undefined, '', 'abc', '-0.1', '1.6', 'NaN', 'Infinity']) {
      const h = headersFrom({
        ...(u !== undefined ? { 'anthropic-ratelimit-unified-5h-utilization': u } : {}),
        'anthropic-ratelimit-unified-5h-reset': String(secs(reset5h)),
      });
      expect(windowsFromHeaders('anthropic', h, now), String(u)).toEqual([]);
    }
  });

  it('keeps a readable utilization without its reset when the reset is unreadable', () => {
    const h = headersFrom({
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': 'soon',
    });
    expect(windowsFromHeaders('anthropic', h, now)).toEqual([
      { kind: '7d', usedPercent: 100, windowMins: 10_080, source: 'headers', at: iso(now) },
    ]);
  });

  it('reads nothing for another provider, or for headers it does not know', () => {
    expect(windowsFromHeaders('openai', claude, now)).toEqual([]);
    const other = headersFrom({
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.5',
      'anthropic-ratelimit-unified-overage-utilization': '0.5',
      'anthropic-ratelimit-requests-remaining': '10',
    });
    expect(windowsFromHeaders('anthropic', other, now)).toEqual([]);
  });
});

describe('headerInstantMs', () => {
  it('reads unix seconds and RFC 3339; anything else is NaN', () => {
    expect(headerInstantMs('1792612800')).toBe(1792612800_000);
    expect(headerInstantMs(' 1792612800.4 ')).toBe(1792612800_400);
    expect(headerInstantMs('2026-10-21T20:00:00Z')).toBe(Date.parse('2026-10-21T20:00:00Z'));
    expect(headerInstantMs('soon')).toBeNaN();
    expect(headerInstantMs(undefined)).toBeNaN();
  });
});

describe('detectFromHttp reads the subscription reset as unix seconds', () => {
  it('parks a Claude 429 until anthropic-ratelimit-unified-reset (unix seconds)', () => {
    const reset = secs(now + 4 * 3_600_000);
    const sig = detectFromHttp(
      'anthropic',
      429,
      headersFrom({
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-reset': String(reset),
      }),
      '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}',
      now,
    );
    expect(sig).toMatchObject({ kind: 'rate-limit', resetAt: iso(reset * 1000) });
  });

  it('still reads an RFC 3339 reset', () => {
    const reset = iso(now + 3_600_000);
    const sig = detectFromHttp(
      'anthropic',
      429,
      headersFrom({ 'anthropic-ratelimit-requests-reset': reset }),
      'limited',
      now,
    );
    expect(sig?.resetAt).toBe(reset);
  });

  it('reads the unified reset only while the subscription limit itself refused the call (review)', () => {
    // Anthropic sends unified-reset on every subscription response (the end of the
    // current window, hours away). A 429 the subscription limit did not cause keeps
    // its own retry-after: parking until the window ends would take a working
    // account out for hours.
    const windowEnd = String(secs(now + 4 * 3_600_000));
    const body = '{"type":"error","error":{"type":"rate_limit_error","message":"limited"}}';
    const cases: Array<[string, Record<string, string>]> = [
      ['allowed', { 'anthropic-ratelimit-unified-status': 'allowed' }],
      ['allowed_warning', { 'anthropic-ratelimit-unified-status': 'allowed_warning' }],
      [
        'rejected, overage serving',
        {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-overage-status': 'allowed',
        },
      ],
    ];
    for (const [name, extra] of cases) {
      const sig = detectFromHttp(
        'anthropic',
        429,
        headersFrom({
          ...extra,
          'anthropic-ratelimit-unified-reset': windowEnd,
          'retry-after': '30',
        }),
        body,
        now,
      );
      expect(sig?.resetAt, name).toBeUndefined();
      expect(sig?.retryAfterMs, name).toBe(30_000);
    }
    const counted: Array<[string, Record<string, string>]> = [
      [
        'rejected, overage rejected too',
        {
          'anthropic-ratelimit-unified-status': 'Rejected',
          'anthropic-ratelimit-unified-overage-status': 'rejected',
        },
      ],
      // A host that forwarded the reset without its status is taken at its word.
      ['no status', {}],
    ];
    for (const [name, extra] of counted) {
      const sig = detectFromHttp(
        'anthropic',
        429,
        headersFrom({
          ...extra,
          'anthropic-ratelimit-unified-reset': windowEnd,
          'retry-after': '30',
        }),
        body,
        now,
      );
      expect(sig?.resetAt, name).toBe(iso(Number(windowEnd) * 1000));
    }
  });
});

describe('limitsFromRateLimits (Codex)', () => {
  const resetPrimary = secs(now + 3 * 3_600_000);
  const resetSecondary = secs(now + 4 * 86_400_000);
  const snapshot = {
    planType: 'plus',
    limitId: 'codex',
    rateLimitReachedType: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: resetPrimary },
    secondary: { usedPercent: 38, windowDurationMins: 10_080, resetsAt: resetSecondary },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    observedAt: secs(now) - 30,
  };

  it('reads planType and the primary / secondary windows, at the host’s observedAt', () => {
    const at = iso((secs(now) - 30) * 1000);
    expect(limitsFromRateLimits(snapshot, now)).toEqual({
      plan: { plan: 'plus', source: 'rate-limits', at },
      windows: [
        {
          kind: 'primary',
          usedPercent: 12,
          windowMins: 300,
          resetsAt: iso(resetPrimary * 1000),
          source: 'rate-limits',
          at,
        },
        {
          kind: 'secondary',
          usedPercent: 38,
          windowMins: 10_080,
          resetsAt: iso(resetSecondary * 1000),
          source: 'rate-limits',
          at,
        },
      ],
    });
  });

  it('uses now for an observedAt that is missing, in the future or too old', () => {
    for (const observedAt of [undefined, secs(now) + 3600, secs(now) - 40 * 86_400, 'x', -1]) {
      const r = limitsFromRateLimits({ planType: 'pro', observedAt } as never, now);
      expect(r.plan?.at, String(observedAt)).toBe(iso(now));
    }
  });

  it('drops an unreadable window and leaves unreadable fields out of a readable one', () => {
    const r = limitsFromRateLimits(
      {
        primary: { usedPercent: 'lots', windowDurationMins: 300, resetsAt: resetPrimary },
        secondary: { usedPercent: 50, windowDurationMins: -1, resetsAt: 12 },
      } as never,
      now,
    );
    expect(r.plan).toBeUndefined();
    expect(r.windows).toEqual([
      { kind: 'secondary', usedPercent: 50, source: 'rate-limits', at: iso(now) },
    ]);
    for (const bad of [null, [], 'x', { usedPercent: -3 }, { usedPercent: 151 }, {}]) {
      expect(
        limitsFromRateLimits({ primary: bad } as never, now).windows,
        JSON.stringify(bad),
      ).toEqual([]);
    }
  });
});

describe('the Claude status output names the plan', () => {
  const run = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });
  const plan = (o: unknown) => claudeSpec.status!.plan!(run(JSON.stringify(o, null, 2)));

  it('reads subscriptionType while signed in, and nothing else the output carries', () => {
    const live = {
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      email: 'someone@example.test',
      orgId: '00000000-0000-0000-0000-000000000000',
      orgName: "someone@example.test's Organization",
      subscriptionType: 'max',
    };
    expect(plan(live)).toBe('max');
    expect(plan({ ...live, subscriptionType: null })).toBeUndefined();
    expect(plan({ ...live, loggedIn: false })).toBeUndefined();
    expect(plan({ loggedIn: true })).toBeUndefined();
    expect(claudeSpec.status!.plan!(run('Logged in as someone'))).toBeUndefined();
  });

  it('Codex status names no plan (it prints only how it is signed in)', () => {
    expect(codexSpec.status?.plan).toBeUndefined();
  });
});

describe('normalizePlan', () => {
  it('keeps a vendor plan word, lowercased; refuses anything else', () => {
    expect(normalizePlan('max')).toBe('max');
    expect(normalizePlan(' Plus ')).toBe('plus');
    expect(normalizePlan('edu_plus')).toBe('edu_plus');
    for (const v of [
      undefined,
      null,
      3,
      '',
      'unknown',
      'someone@example.test',
      'Max plan for you',
      'a'.repeat(41),
      '1max',
    ])
      expect(normalizePlan(v), String(v)).toBeUndefined();
  });
});

describe('mergeWindows / applyLimits', () => {
  const w = (kind: string, usedPercent: number, atMs: number, resetMs?: number): AccountWindow => ({
    kind,
    usedPercent,
    ...(resetMs !== undefined ? { resetsAt: iso(resetMs) } : {}),
    source: 'headers',
    at: iso(atMs),
  });

  it('keeps the latest reading per kind; an older reading never replaces a newer one', () => {
    const stored = [w('5h', 40, now - 1000, now + 3_600_000), w('7d', 70, now - 1000)];
    const merged = mergeWindows(stored, [w('5h', 10, now - 5000), w('7d', 75, now)], now);
    expect(merged).toEqual([w('5h', 40, now - 1000, now + 3_600_000), w('7d', 75, now)]);
  });

  it('drops a window whose reset has passed', () => {
    expect(mergeWindows([w('5h', 99, now - 9000, now - 1)], [w('7d', 5, now)], now)).toEqual([
      w('7d', 5, now),
    ]);
  });

  it('applyLimits sets the plan unless a later one is stored, and reports changes', () => {
    const st: ProfileState = { profileId: 'a', status: 'ready', served: 0 };
    expect(
      applyLimits(
        st,
        { plan: { plan: 'max', source: 'cli-status', at: iso(now) }, windows: [] },
        now,
      ),
    ).toBe(true);
    expect(st).toMatchObject({ plan: 'max', planSource: 'cli-status', planAt: iso(now) });
    expect(
      applyLimits(
        st,
        { plan: { plan: 'pro', source: 'rate-limits', at: iso(now - 1) }, windows: [] },
        now,
      ),
    ).toBe(false);
    expect(st.plan).toBe('max');
    expect(
      applyLimits(
        st,
        { plan: { plan: 'max', source: 'cli-status', at: iso(now) }, windows: [] },
        now,
      ),
    ).toBe(false);
    expect(st.windows).toBeUndefined();
  });

  it('learnLimits joins the headers and a snapshot of one report', () => {
    const l = learnLimits(
      'anthropic',
      {
        headers: headersFrom({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }),
        rateLimits: { planType: 'max' },
      },
      now,
    );
    expect(l.plan?.plan).toBe('max');
    expect(l.windows.map((x) => x.kind)).toEqual(['5h']);
  });
});

describe('exhaustedResetAt', () => {
  it('is the latest reset among the windows at 100% or more with a reset ahead', () => {
    const at = iso(now);
    const ws: AccountWindow[] = [
      {
        kind: 'primary',
        usedPercent: 100,
        resetsAt: iso(now + 3_600_000),
        source: 'rate-limits',
        at,
      },
      {
        kind: 'secondary',
        usedPercent: 100,
        resetsAt: iso(now + 86_400_000),
        source: 'rate-limits',
        at,
      },
    ];
    expect(exhaustedResetAt(ws, now)).toBe(iso(now + 86_400_000));
    expect(exhaustedResetAt([{ ...ws[1]!, usedPercent: 99 }, ws[0]!], now)).toBe(
      iso(now + 3_600_000),
    );
    expect(exhaustedResetAt([{ ...ws[0]!, resetsAt: iso(now - 1) }], now)).toBeUndefined();
    expect(exhaustedResetAt([{ ...ws[0]!, usedPercent: 50 }], now)).toBeUndefined();
  });
});
