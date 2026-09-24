# Failover policy

The router implements one policy: **ordered, same-provider, cooldown with automatic return.** This page is the contract.

## Order

Each provider's profiles carry an integer `order`. Lower serves first. `activate(id)` moves a profile to order 0 and renumbers the rest, which is what the switcher's "Use this" button does. `reorder(provider, ids)` sets the full sequence.

## Signals and cooldowns

| Signal            | Typical source                                      | Cooldown when the provider gives no reset time                                                     |
| ----------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `rate-limit`      | 429 with reset headers, "too many requests"         | `defaultRateLimitCooldownMs` (60 s)                                                                |
| `quota-exhausted` | CLI "usage limit reached", plan window used up      | `defaultQuotaCooldownMs` (30 min)                                                                  |
| `billing`         | 402, `insufficient_quota`, "credit balance too low" | `billingCooldownMs` (24 h)                                                                         |
| `overloaded`      | 529 / 503, "overloaded"                             | retried on the same account `overloadRetries` times with backoff, then `overloadCooldownMs` (15 s) |
| `auth-expired`    | 401, "not logged in", "token expired"               | not a timed park: the profile becomes `unauthenticated` until someone logs in                      |

A provider-supplied reset (`resetAt` or `retryAfterMs`) always wins over the default, capped by `maxCooldownMs` (7 days) and floored at 1 s. Policy values can be overridden globally or per provider:

```ts
createIronProxy({
  policy: { defaultQuotaCooldownMs: 3_600_000, providers: { anthropic: { overloadRetries: 2 } } },
});
```

Two more policy fields shape behaviour rather than timing, and can be overridden per provider the same way:

| Field                  | Default | Effect                                                                                               |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `preemptAtUtilisation` | `0.95`  | Try a nearly-full account last (see [Switch before the wall](#switch-before-the-wall)). `>= 1`: off. |
| `resumeInterrupted`    | `false` | Continue a stream cut off mid-answer on the next account (see [Streaming](#streaming)).              |

## Selection algorithm

```
candidates = enabled profiles of provider, sorted by order
move 'hot' candidates to the end, unless every candidate is hot   # switch before the wall
for p in candidates:
  if p is parked and parkedUntil <= now: unpark p            # auto-return
  if p is parked: skip
  if p is unauthenticated and not explicitly pinned: skip
  try p
    success → p becomes active; done
    quota signal → park p; continue
    other error → throw (the request is wrong, not the account)
no candidate left → AllProfilesExhaustedError(earliest parkedUntil)
```

Because parks are cleared lazily on the next selection, no timers run in the background and nothing polls the provider. The primary returns the moment it is eligible and a request arrives.

## Switch before the wall

Accounts report usage as they serve (rate-limit headers on the API lanes, usage hints from a CLI), and the router keeps the latest snapshot in `ProfileState.usage`. A candidate is **hot** when that snapshot says at least `preemptAtUtilisation` of the window is used (`utilisation >= 0.95` by default) **and** its `resetAt` is still in the future. For that request, hot candidates move to the end of the order, keeping their relative order. Nothing is parked and nothing is written: the next request looks again, and once the window resets the account is first again.

- Usage whose `resetAt` has passed is stale and ignored. Usage without a `resetAt` never makes an account hot, and is treated as stale once it is more than ten minutes old.
- If every candidate is hot, the normal order is used. Pre-emption reorders; it never refuses a request.
- A pinned request (`profileId`) is never reordered: you chose that account.
- It stays inside the provider, like all failover.
- When a request is served by a later account because an earlier one was hot, and that changes the active account, `profile.switched` carries a reason with `source: 'usage'`, `kind: 'rate-limit'`, the window's `resetAt`, and a message like `Switched early: 96% of the window used, resets 3:40 PM`. No account name, email or secret is ever in it.
- Set `preemptAtUtilisation: 1` (globally or for one provider) to turn it off.

## Pinning

`{ profileId }` starts on that profile, then falls back to the rest in order. `{ profileId, strict: true }` never leaves it and surfaces `QuotaExceededError` instead of switching. Pinning a profile also lets an `unauthenticated` profile be tried (so a login can be verified by a real request).

## Streaming

- Signal before the first byte: silent switch. The stream carries a `switched` event first (the proxy emits it as an SSE comment so wire-compatible clients ignore it).
- Signal after content has flowed: by default the stream ends with an `error` event `STREAM_INTERRUPTED` (`retryable: true`), the account is parked, and the next attempt lands elsewhere.
- On the Anthropic API lane, a mid-stream `error` event of type `rate_limit_error` or `overloaded_error` counts as a limit (a `rate-limit` or `overloaded` signal), not as a plain provider error.

### Continuing a cut-off answer (opt-in)

With `resumeInterrupted` on (policy, `RunOptions.resumeInterrupted`, the proxy header `x-iron-resume: 1`, or `iron-proxy chat --resume`), a limit that arrives **after text was streamed and while no tool call is open** does not end the stream. The account is parked as usual, and the next ready account **of the same provider** receives a continuation request: the original request, plus an assistant message holding exactly the text streamed so far, plus a user message `Continue exactly where you stopped. Do not repeat any text you already wrote.` The Anthropic API-key lane continues an assistant prefill natively, so it gets the partial text as the last (assistant) message with no extra user turn, trailing whitespace trimmed because Anthropic rejects a prefill that ends in whitespace.

The caller sees the original `start`, the text so far, then a `switched` event with `resumed: true`, then only the continuation's text, usage and finish (its own `start` is swallowed). The proxy writes the switch as an SSE comment ending in `resumed`. If the continuation is cut off too, the next account continues it, and so on; when nobody is left, the stream ends with the same `STREAM_INTERRUPTED` error as before. A limit inside an open tool call, or with resume off, behaves exactly as before. Non-streaming `complete()` is unaffected: it already fails over before anything is returned.

**Why it is off by default:** the join between the two accounts' text can occasionally show a seam, such as a repeated or missing word or a changed tone, because a different account (with no memory of the first one's reasoning) writes the rest. Turn it on where a finished answer matters more than a perfect join.

## What never happens

- **No cross-provider fallback.** Your Claude request never goes to OpenAI because Claude accounts are parked. The host receives `provider.exhausted` and decides. This is a data-handling guarantee, not just a preference.
- **No silent model downgrade.** The model you asked for is the model sent. If an account cannot serve it, that is a provider error, surfaced.
- **No background probing.** Iron-Proxy does not spend your quota checking whether it is back.

## Usage history does not steer failover

The router's only new behaviour for the usage history is a hook: `Router.onUsage(listener)` is called after each usage snapshot a lane reports has been stored on the account's state. The manager uses it to record utilisation samples for `usageReport()`. The history and its time-left estimate are for people to read; they never park, reorder or pre-empt an account, and they never trigger a request to a provider.

## Events you can drive a UI from

`profile.parked` (with `until`), `profile.unparked`, `profile.switched` (with the reason when caused by a signal, `source: 'usage'` when it was an early switch), `provider.exhausted` (with `earliestResetAt`), `profile.state` (every state change), `request.started/finished/failed`, `login` (URL, code, output lines, completed/failed).
