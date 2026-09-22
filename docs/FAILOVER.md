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

## Selection algorithm

```
candidates = enabled profiles of provider, sorted by order
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

## Pinning

`{ profileId }` starts on that profile, then falls back to the rest in order. `{ profileId, strict: true }` never leaves it and surfaces `QuotaExceededError` instead of switching. Pinning a profile also lets an `unauthenticated` profile be tried (so a login can be verified by a real request).

## Streaming

- Signal before the first byte: silent switch. The stream carries a `switched` event first (the proxy emits it as an SSE comment so wire-compatible clients ignore it).
- Signal after content has flowed: the stream ends with an `error` event `STREAM_INTERRUPTED` (`retryable: true`), the account is parked, and the next attempt lands elsewhere. Splicing two accounts' partial answers would produce garbage, so it is not attempted.

## What never happens

- **No cross-provider fallback.** Your Claude request never goes to OpenAI because Claude accounts are parked. The host receives `provider.exhausted` and decides. This is a data-handling guarantee, not just a preference.
- **No silent model downgrade.** The model you asked for is the model sent. If an account cannot serve it, that is a provider error, surfaced.
- **No background probing.** Iron-Proxy does not spend your quota checking whether it is back.

## Events you can drive a UI from

`profile.parked` (with `until`), `profile.unparked`, `profile.switched` (with the reason when caused by a signal), `provider.exhausted` (with `earliestResetAt`), `profile.state` (every state change), `request.started/finished/failed`, `login` (URL, code, output lines, completed/failed).
