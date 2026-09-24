import type { IronEvent, Profile, ProviderId, QuotaSignal } from '@iron-proxy/core';

/**
 * Desktop notifications for the moments a user should hear about without
 * watching the app: an automatic switch to another account, an account parked
 * with nothing to take over, every account of a provider resting, and a sign-in
 * that finished or failed.
 *
 * Two layers:
 * - `notificationFor(event, ctx)` is pure: one IronEvent in, one title + body out
 *   (or nothing). Bodies are built from profile titles and provider names only,
 *   never from ids, emails, vendor messages or secrets.
 * - `createNotifier(opts)` subscribes to an IronProxy or IronClient and adds what
 *   a pure mapping cannot: the park -> switch coalescing, a throttle, the user's
 *   settings and the injected Electron `Notification` class.
 */

export type NotificationKind = 'switched' | 'parked' | 'exhausted' | 'login' | 'resumed';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'switched',
  'parked',
  'exhausted',
  'login',
  'resumed',
] as const;

export interface DesktopNotification {
  kind: NotificationKind;
  title: string;
  body: string;
}

export interface NotificationContext {
  /** The profile's user-facing title, or undefined when it is not known. */
  profileTitle(id: string): string | undefined;
  /** Short provider name, e.g. "Claude". */
  providerName(id: ProviderId): string;
  /** Milliseconds since the epoch. */
  now(): number;
  /** BCP 47 locale for clock times. Defaults to the runtime's. */
  locale?: string;
  /** IANA time zone for clock times. Defaults to the runtime's. */
  timeZone?: string;
  /** When a profile is parked until, if known (used for "Back at ..." on a switch). */
  parkedUntil?(profileId: string): string | undefined;
}

/** Default short names for the provider ids, used in titles and bodies. */
export const DEFAULT_PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  anthropic: 'Claude',
  openai: 'ChatGPT',
  google: 'Gemini',
  xai: 'Grok',
  'openai-compatible': 'OpenAI-compatible',
};

const EMAIL = /[^\s@"<>()]+@[^\s@"<>()]+\.[^\s@"<>()]+/g;
const MAX_TITLE = 60;

/**
 * A title as it may appear in a notification: trimmed, capped, and with anything
 * shaped like an email address replaced, in case a user titled an account with it.
 */
export function safeTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const clean = title.replace(EMAIL, '(account)').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1)}…` : clean;
}

/**
 * "3:40 PM" for a time later today (or within the next 20 hours), "Tue 3:40 PM"
 * further out. Undefined for an unparseable time or one that has already passed.
 */
export function formatClockTime(
  iso: string,
  now: number,
  locale?: string,
  timeZone?: string,
): string | undefined {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at) || at <= now) return undefined;
  const far = at - now > 20 * 3_600_000;
  const fmt = new Intl.DateTimeFormat(locale, {
    ...(far ? { weekday: 'short' as const } : {}),
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
  // Some ICU versions put a narrow no-break space before AM/PM.
  return fmt.format(at).replace(/[\u202f\u00a0]/g, ' ');
}

function resetIso(reason: QuotaSignal | undefined, now: number): string | undefined {
  if (!reason) return undefined;
  if (reason.resetAt) return reason.resetAt;
  if (reason.retryAfterMs !== undefined) return new Date(now + reason.retryAfterMs).toISOString();
  return undefined;
}

function quoted(title: string | undefined): string | undefined {
  return title === undefined ? undefined : `"${title}"`;
}

/** Percentage from the router's pre-emptive switch message ("Switched early: 96% ..."). */
function usedPercent(reason: QuotaSignal): number | undefined {
  const m = /(\d{1,3})\s*%/.exec(reason.message ?? '');
  return m ? Number(m[1]) : undefined;
}

function whyItMoved(subject: string, reason: QuotaSignal): string {
  if (reason.source === 'usage') {
    const pct = usedPercent(reason);
    return pct === undefined
      ? `${subject} was nearly full, so Iron-Proxy switched early.`
      : `${subject} switched early, ${pct}% used.`;
  }
  switch (reason.kind) {
    case 'auth-expired':
      return `${subject} needs to sign in again.`;
    case 'billing':
      return `${subject} has a billing problem.`;
    case 'overloaded':
      return `${subject} is busy right now.`;
    default:
      return `${subject} hit its limit.`;
  }
}

/**
 * The notification one event deserves, or undefined.
 *
 * - `profile.switched` with a reason (automatic failover or a pre-emptive switch)
 *   -> `switched`. A switch without a reason (the user's own choice, or the first
 *   request of a session) -> nothing.
 * - `profile.parked` -> `parked`, except for `overloaded` (a short capacity blip,
 *   retried by itself). `createNotifier` drops a park that a switch follows.
 * - `provider.exhausted` -> `exhausted`.
 * - `login` completed / failed -> `login`. Started, progress and cancel -> nothing.
 *
 * `resumed` is reserved: the manager's IronEvents do not say whether an answer
 * was continued on the new account (only the stream's own `switched` event
 * does), so this mapping does not produce it today.
 */
export function notificationFor(
  event: IronEvent,
  ctx: NotificationContext,
): DesktopNotification | undefined {
  const now = ctx.now();
  const title = (id: string) => safeTitle(ctx.profileTitle(id));
  const clock = (iso: string | undefined) =>
    iso === undefined ? undefined : formatClockTime(iso, now, ctx.locale, ctx.timeZone);

  switch (event.type) {
    case 'profile.switched': {
      const reason = event.reason;
      if (!reason) return undefined;
      const provider = ctx.providerName(event.provider);
      const to = quoted(title(event.toProfileId));
      const from = event.fromProfileId === undefined ? undefined : title(event.fromProfileId);
      const subject = quoted(from) ?? `The previous ${provider} account`;
      const back = clock(
        resetIso(reason, now) ??
          (event.fromProfileId === undefined ? undefined : ctx.parkedUntil?.(event.fromProfileId)),
      );
      const tail = back
        ? reason.source === 'usage'
          ? ` Resets at ${back}.`
          : ` Back at ${back}.`
        : '';
      return {
        kind: 'switched',
        title: to ? `Switched to ${to}` : `Switched to another ${provider} account`,
        body: `${whyItMoved(subject, reason)}${tail}`,
      };
    }
    case 'profile.parked': {
      const reason = event.reason;
      if (reason.kind === 'overloaded') return undefined;
      const name = quoted(title(event.profileId));
      if (reason.kind === 'auth-expired') {
        return {
          kind: 'parked',
          title: name ? `${name} needs to sign in again` : 'An account needs to sign in again',
          body: 'Sign in again to keep using it.',
        };
      }
      if (reason.kind === 'billing') {
        return {
          kind: 'parked',
          title: name ? `${name} has a billing problem` : 'An account has a billing problem',
          body: 'Check the plan or credit on this account.',
        };
      }
      const back = clock(event.until ?? resetIso(reason, now));
      return {
        kind: 'parked',
        title: name ? `${name} is resting` : 'An account is resting',
        body: back ? `It hit its limit. Back at ${back}.` : 'It hit its limit.',
      };
    }
    case 'provider.exhausted': {
      const provider = ctx.providerName(event.provider);
      const back = clock(event.earliestResetAt);
      return {
        kind: 'exhausted',
        title: `All ${provider} accounts are resting`,
        body: `${back ? `Earliest back at ${back}. ` : ''}Add another ${provider} account to keep going.`,
      };
    }
    case 'login': {
      const e = event.event;
      if (e.type !== 'completed' && e.type !== 'failed') return undefined;
      const name = quoted(title(e.profileId));
      // The failure message is the vendor CLI's and may carry an email: never shown.
      return e.type === 'completed'
        ? {
            kind: 'login',
            title: name ? `Signed in: ${name}` : 'Signed in',
            body: 'The account is ready to use.',
          }
        : {
            kind: 'login',
            title: name ? `Sign-in did not finish: ${name}` : 'Sign-in did not finish',
            body: 'Try signing in again.',
          };
    }
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* createNotifier                                                      */
/* ------------------------------------------------------------------ */

export interface NotifierSettings {
  /** Master switch. Default true. */
  enabled?: boolean;
  /** Per-kind switches. A kind left out is on. */
  kinds?: Partial<Record<NotificationKind, boolean>>;
}

export interface NotificationOptionsLike {
  title: string;
  body: string;
  silent?: boolean;
}

export interface NotificationLike {
  show(): void;
}

/** Structural subset of Electron's `Notification` class. Pass the real one. */
export interface NotificationClassLike {
  new (options: NotificationOptionsLike): NotificationLike;
  isSupported(): boolean;
}

export interface NotifierClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Anything with `onEvent` + `listProfiles`: an IronClient (LocalIronClient, HttpIronClient). */
export interface NotifierClientLike {
  onEvent(listener: (event: IronEvent) => void): () => void;
  listProfiles(): Promise<Profile[]>;
}

/** An IronProxy (or anything with its `events.onAny` + `listProfiles`). */
export interface NotifierIronLike {
  events: { onAny(listener: (event: IronEvent) => void): () => void };
  listProfiles(): Promise<Profile[]>;
}

interface NotifierCommonOptions {
  /** Electron's `Notification` class (or a fake in tests). */
  Notification: NotificationClassLike;
  settings?: NotifierSettings;
  clock?: NotifierClock;
  /** Identical (kind, account) notifications within this window are dropped. Default 60000. */
  throttleMs?: number;
  /** How long a park waits for the switch that usually follows it. Default 2000. */
  coalesceMs?: number;
  /**
   * Hard ceiling on how long a park can be held while waiting for a switch,
   * measured from the park. A request that is abandoned (the caller stops a
   * stream) never reports finished, so without this a park could wait forever.
   * Default 45000.
   */
  maxHoldMs?: number;
  locale?: string;
  timeZone?: string;
  /** Override the short provider names used in the text. */
  providerNames?: Partial<Record<ProviderId, string>>;
  /** Called when showing a notification or reading profiles fails. Never throws into the host. */
  onError?: (err: unknown) => void;
}

export type CreateNotifierOptions = NotifierCommonOptions &
  ({ iron: NotifierIronLike; client?: never } | { client: NotifierClientLike; iron?: never });

export interface Notifier {
  /** Stop listening and cancel any pending notification. */
  dispose(): void;
  /** Replace the settings (enabled / kinds). Applies to notifications not yet shown. */
  setSettings(settings: NotifierSettings): void;
  /** Resolves once every event received so far has been handled. For tests. */
  settled(): Promise<void>;
}

export const DEFAULT_NOTIFY_THROTTLE_MS = 60_000;
export const DEFAULT_PARK_COALESCE_MS = 2_000;
export const DEFAULT_PARK_MAX_HOLD_MS = 45_000;

const systemClock: NotifierClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface PendingPark {
  event: Extract<IronEvent, { type: 'profile.parked' }>;
  provider: ProviderId | undefined;
  timer: unknown;
  /** Fires `maxHoldMs` after the park and shows it whatever it is waiting on. */
  ceiling: unknown;
  /** Same-provider requests on another account that started after the park. */
  waitingOn: Set<string>;
}

/**
 * Subscribe to Iron-Proxy events and show desktop notifications for them.
 *
 * A park is held for `coalesceMs` (and for as long as a request that started
 * after it on another account of the same provider is still running), because
 * the router announces the switch only once the next account has answered: when
 * that switch arrives, the park is dropped and one "Switched to ..." shows. The
 * hold never exceeds `maxHoldMs` from the park, so an abandoned request cannot
 * swallow it. A
 * `provider.exhausted` for the provider also replaces its pending parks.
 */
export function createNotifier(opts: CreateNotifierOptions): Notifier {
  const clock = opts.clock ?? systemClock;
  const throttleMs = opts.throttleMs ?? DEFAULT_NOTIFY_THROTTLE_MS;
  const coalesceMs = opts.coalesceMs ?? DEFAULT_PARK_COALESCE_MS;
  const maxHoldMs = Math.max(opts.maxHoldMs ?? DEFAULT_PARK_MAX_HOLD_MS, coalesceMs);
  const names: Record<ProviderId, string> = { ...DEFAULT_PROVIDER_NAMES, ...opts.providerNames };
  const onError = opts.onError ?? (() => {});
  const NotificationClass = opts.Notification;
  let settings: NotifierSettings = { ...opts.settings };
  let disposed = false;

  const profiles = new Map<string, { title: string; provider: ProviderId }>();
  const parkedUntil = new Map<string, string>();
  const pending = new Map<string, PendingPark>();
  const lastShown = new Map<string, number>();

  const listProfiles = (): Promise<Profile[]> =>
    opts.iron ? opts.iron.listProfiles() : opts.client.listProfiles();

  const remember = (p: Profile) => profiles.set(p.id, { title: p.title, provider: p.provider });

  async function refresh(): Promise<void> {
    try {
      const list = await listProfiles();
      profiles.clear();
      for (const p of list) remember(p);
    } catch (err) {
      onError(err);
    }
  }

  const ctx: NotificationContext = {
    profileTitle: (id) => profiles.get(id)?.title,
    providerName: (id) => names[id] ?? id,
    now: () => clock.now(),
    parkedUntil: (id) => parkedUntil.get(id),
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  };

  function allowed(kind: NotificationKind): boolean {
    if (settings.enabled === false) return false;
    return settings.kinds?.[kind] !== false;
  }

  function show(n: DesktopNotification | undefined, key: string): void {
    if (!n || disposed || !allowed(n.kind)) return;
    const throttleKey = `${n.kind}:${key}`;
    const now = clock.now();
    const last = lastShown.get(throttleKey);
    if (last !== undefined && now - last < throttleMs) return;
    try {
      if (!NotificationClass.isSupported()) return;
      new NotificationClass({ title: n.title, body: n.body, silent: false }).show();
      lastShown.set(throttleKey, now);
    } catch (err) {
      onError(err);
    }
  }

  function releasePark(p: PendingPark): void {
    if (pending.get(p.event.profileId) !== p) return;
    dropPark(p);
    show(notificationFor(p.event, ctx), p.event.profileId);
  }

  function armPark(p: PendingPark): void {
    if (p.timer !== undefined) clock.clearTimeout(p.timer);
    p.timer = clock.setTimeout(() => {
      p.timer = undefined;
      if (p.waitingOn.size) return;
      releasePark(p);
    }, coalesceMs);
  }

  function dropPark(p: PendingPark): void {
    if (p.timer !== undefined) clock.clearTimeout(p.timer);
    if (p.ceiling !== undefined) clock.clearTimeout(p.ceiling);
    p.timer = undefined;
    p.ceiling = undefined;
    p.waitingOn.clear();
    if (pending.get(p.event.profileId) === p) pending.delete(p.event.profileId);
  }

  function referencedIds(e: IronEvent): string[] {
    switch (e.type) {
      case 'profile.switched':
        return e.fromProfileId ? [e.toProfileId, e.fromProfileId] : [e.toProfileId];
      case 'profile.parked':
        return [e.profileId];
      case 'login':
        return e.event.type === 'completed' || e.event.type === 'failed' ? [e.event.profileId] : [];
      default:
        return [];
    }
  }

  async function handle(e: IronEvent): Promise<void> {
    if (disposed) return;
    switch (e.type) {
      case 'profile.created':
      case 'profile.updated':
        remember(e.profile);
        return;
      case 'profile.deleted':
        profiles.delete(e.profileId);
        parkedUntil.delete(e.profileId);
        {
          const p = pending.get(e.profileId);
          if (p) dropPark(p);
        }
        return;
      case 'profile.unparked':
        parkedUntil.delete(e.profileId);
        return;
      default:
        break;
    }
    if (referencedIds(e).some((id) => !profiles.has(id))) await refresh();
    if (disposed) return;

    switch (e.type) {
      case 'profile.parked': {
        if (e.until) parkedUntil.set(e.profileId, e.until);
        else parkedUntil.delete(e.profileId);
        if (!notificationFor(e, ctx)) return; // e.g. overloaded: nothing to hold
        const prev = pending.get(e.profileId);
        if (prev) dropPark(prev);
        const p: PendingPark = {
          event: e,
          provider: profiles.get(e.profileId)?.provider,
          timer: undefined,
          ceiling: undefined,
          waitingOn: new Set(),
        };
        pending.set(e.profileId, p);
        armPark(p);
        p.ceiling = clock.setTimeout(() => {
          p.ceiling = undefined;
          releasePark(p);
        }, maxHoldMs);
        return;
      }
      case 'request.started': {
        for (const p of pending.values()) {
          if (p.provider !== e.provider || p.event.profileId === e.profileId) continue;
          if (p.timer !== undefined) clock.clearTimeout(p.timer);
          p.timer = undefined;
          p.waitingOn.add(e.requestId);
        }
        return;
      }
      case 'request.finished':
      case 'request.failed': {
        for (const p of [...pending.values()]) {
          if (!p.waitingOn.delete(e.requestId)) continue;
          if (!p.waitingOn.size) armPark(p);
        }
        return;
      }
      case 'profile.switched': {
        if (!e.reason) return; // the user's own choice: silent
        // Only the park of the account the switch came from is replaced by the
        // switch; parks of other accounts keep their own timers.
        let fromId = e.fromProfileId;
        if (fromId !== undefined) {
          const p = pending.get(fromId);
          if (p) dropPark(p);
        } else {
          let latest: PendingPark | undefined;
          for (const p of pending.values()) if (p.provider === e.provider) latest = p;
          if (latest) {
            dropPark(latest);
            fromId = latest.event.profileId;
          }
        }
        const ev = fromId === undefined ? e : { ...e, fromProfileId: fromId };
        show(notificationFor(ev, ctx), `${fromId ?? ''}->${e.toProfileId}`);
        return;
      }
      case 'provider.exhausted': {
        for (const p of [...pending.values()]) if (p.provider === e.provider) dropPark(p);
        show(notificationFor(e, ctx), e.provider);
        return;
      }
      case 'login': {
        const n = notificationFor(e, ctx);
        if (n) show(n, `${e.event.type}:${e.event.profileId}`);
        return;
      }
      default:
        return;
    }
  }

  let queue: Promise<void> = refresh();
  const listener = (e: IronEvent) => {
    if (disposed) return;
    queue = queue.then(() => handle(e)).catch(onError);
  };
  const unsubscribe = opts.iron ? opts.iron.events.onAny(listener) : opts.client.onEvent(listener);

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const p of [...pending.values()]) dropPark(p);
    },
    setSettings(s: NotifierSettings) {
      settings = { ...s };
    },
    async settled() {
      let seen: Promise<void> | undefined;
      while (seen !== queue) {
        seen = queue;
        await queue;
      }
    },
  };
}
