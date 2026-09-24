# Architecture

Iron-Proxy is one data model, one router, and adapters that are mostly data. This page is the map.

```
┌──────────────── host app ────────────────┐
│  React <AccountSwitcher/>  ──IronClient──┼──► Electron preload (IPC) ──► main: LocalIronClient
│  any SDK (OpenAI/Anthropic shape) ───────┼──► @iron-proxy/proxy  ──────► IronProxy
└──────────────────────────────────────────┘                                 │
                                                                             ▼
                                   ┌───────────────────── @iron-proxy/core ─────────────────────┐
                                   │ IronProxy (manager)                                        │
                                   │   ├─ ProfileStore   profiles.json   (title, provider, lane, order) │
                                   │   ├─ StateStore     state.json      (parkedUntil, usage, served)   │
                                   │   ├─ UsageStore     usage.json      (requests, parks, samples; 14 d) │
                                   │   ├─ Vault          vault.json + vault.key (AES-256-GCM)           │
                                   │   ├─ AdapterRegistry                                              │
                                   │   │    anthropic ─ api-key lane ─ Messages API                    │
                                   │   │              └ cli lane ─── claude  (CLAUDE_CONFIG_DIR)        │
                                   │   │    openai ──── api-key lane ─ Chat Completions                 │
                                   │   │              └ cli lane ─── codex   (CODEX_HOME)               │
                                   │   │    google ──── api-key lane ─ generateContent                  │
                                   │   │              └ cli lane ─── gemini  (GEMINI_CLI_HOME)          │
                                   │   │    xai ─────── api-key lane ─ OpenAI-compatible                │
                                   │   │              └ cli lane ─── grok    (GROK_HOME)                │
                                   │   │    openai-compatible ─ api-key lane                            │
                                   │   ├─ Router        ordered same-provider failover + auto-return   │
                                   │   └─ TypedEmitter  IronEvent stream                               │
                                   └────────────────────────────────────────────────────────────┘
```

## Vocabulary

| Term                | Meaning                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profile**         | One titled account of one provider in one lane. Persisted. Has an `order` within its provider.                                                                      |
| **Lane**            | How a profile authenticates and executes: `cli` (vendor CLI in an isolated home), `api-key` (HTTPS with a vaulted key), `oauth` (extension point).                  |
| **Adapter**         | A provider's set of lanes plus a default model.                                                                                                                     |
| **Quota signal**    | A structured reason to stop using an account for a while: `rate-limit`, `quota-exhausted`, `billing`, `auth-expired`, `overloaded`, with an optional reset instant. |
| **Park**            | The state of an account after a quota signal, until `parkedUntil`.                                                                                                  |
| **Unified request** | The provider-neutral chat shape (`system`, `messages` with typed content parts, `tools`, sampling knobs). Everything is translated to and from it.                  |

## Request lifecycle

1. The caller passes a `UnifiedRequest` (or the proxy translates an OpenAI / Anthropic body into one).
2. `Router.resolveProvider` picks the provider: explicit option → pinned profile's provider → inferred from the model name → the only configured provider → error.
3. `Router.candidates` lists enabled profiles of that provider by `order`, skipping parked ones whose `parkedUntil` is in the future (expired parks are cleared on the spot, which is the auto-return) and unauthenticated ones.
4. For each candidate, the lane runs. The lane throws `LaneQuotaSignal` when the _account_ is the problem and `ProviderError` when the _request_ is.
5. On a quota signal the router parks the profile, emits `profile.parked`, and tries the next candidate. In a stream this is silent as long as nothing has reached the caller yet; afterwards the caller gets a retryable `STREAM_INTERRUPTED` error event.
6. On success the profile becomes `active` for its provider, `served` increments, and `request.finished` carries usage.
7. If no candidate remains: `AllProfilesExhaustedError` with the earliest `resetAt` among the parked accounts, and a `provider.exhausted` event. No cross-provider attempt is ever made.

## Where quota signals come from

- **HTTP status + headers** (`quota/detect.ts`): 429 with Anthropic `anthropic-ratelimit-*-reset` instants or OpenAI `x-ratelimit-reset-*` durations ("6m0s"), `retry-after`, Google `retryDelay` in the body; 401/403 → auth; 402 or "insufficient_quota" / "credit balance" → billing; 529/503 → overloaded.
- **CLI output**: broad, case-insensitive patterns for "usage limit", "rate limit", "weekly limit", "not logged in", "overloaded", plus "resets at 3pm" / "try again in 2 hours" parsing. Vendor wording changes, so the patterns are wide and the fallback cooldowns are conservative.

## The CLI lane in one paragraph

A `CliSpec` is a small object: binary name, the env var for the home dir, the argument list for one headless turn with tools disabled, a line parser that turns the CLI's JSONL into text deltas / final text / usage / errors, and the login / logout / status commands. `CliLane` spawns the binary with a scrubbed environment (`PATH`, `HOME`, temp dirs, the home var; every `*_API_KEY` stripped so a stray key cannot bypass the subscription), streams stdout line by line, and maps failures to quota signals. A `.js`/`.mjs` binary runs under the current Node, which is how the test suite drives a fake CLI with the exact same code path as the real ones.

## Storage layout

```
<dataDir>/
  profiles.json      profiles (no secrets)
  state.json         runtime state, safe to delete
  usage.json         usage history per profile (UsageStore): finished requests (time, duration, token counts),
                     parks (time, kind, until) and utilisation samples (time, utilisation, resetAt).
                     Counts and timestamps only; kept 14 days, at most 5000 records per profile; safe to delete
  vault.json         AES-256-GCM entries, ref-bound AAD
  vault.key          master key; in Electron wrapped by safeStorage (DPAPI / Keychain / libsecret)
  cli-homes/<provider>/<profileId>/   isolated vendor CLI home per subscription account
  proxy.json         written by `iron-proxy serve` or the tray app: {url, token, pid}; removed by its owner on exit
  tray-settings.json the tray app's switches (notifications, start at login, proxy port); nothing secret
```

Several processes can use one data directory at once (the CLI, a running `serve`, the tray app). The file profile, state and usage stores never write their whole cache back over the file. Each write takes a small lock file next to the data file (`profiles.json.lock`, `state.json.lock`, `usage.json.lock`; created exclusively, retried with a short backoff for up to about 2 s, and removed as stale when older than 10 s, which is what a crashed process leaves behind; only the waiter holding `<file>.lock.takeover` removes a stale lock, after checking it again, and moves it to a name of its own before deleting it, so two waiters that both find it stale cannot end up holding the lock at once), re-reads the file, applies only this process's own changes (the profiles or states it put, the ids it deleted, the usage records it appended since its last write) and writes the result atomically. A read re-loads the file when it changed on disk (inode, mtime and size), with this process's unsaved changes laid on top. So an account added in the tray survives the CLI's next write, a park recorded by `serve` is not lost, a delete is not brought back by another process's stale cache, and usage records from every process add up. For one account's state the last writer wins. The stores also count the file versions written by another process that they have read (`externalWrites`), which the tray uses to tell another process's changes from its own writes.

An **adopted** profile (`cli.adopted: true`, from `adoptLogin`) points at a directory outside `cli-homes`: the vendor CLI's own default home, such as `~/.claude`. Iron-Proxy runs the CLI there exactly as it runs it in an isolated home, but never prepares, recreates or deletes that directory, and logging it out signs the user's own CLI out. `discoverLogins()` finds candidates through each spec's `defaultHome(env)` and the CLI's own status command.

`pickProfile(provider)` answers "which account would a request use right now" without running one: it walks `Router.candidates()` through `Router.availability()`, the same check each request makes (expired parks cleared, parked and signed-out accounts skipped). `iron-proxy run` starts the vendor CLI interactively as that account with `CliLane.interactiveCommand()` (the lane's scrubbed environment), and `iron-proxy env` prints `CliLane.shellEnv()`; neither reads anything out of the home.

Default `dataDir` is `~/.iron-proxy` (or `IRON_PROXY_DATA_DIR`). Electron hosts get `<userData>/iron-proxy`. Two apps that want to _share_ accounts point at the same `dataDir`; two that want isolation do not. The tray app (`apps/tray`) deliberately uses the CLI's `dataDir` and plain key protector, so the two share accounts both ways; it reuses a running `serve` found through `proxy.json` (pid checked with `process.kill(pid, 0)`) instead of starting a second server.

## Usage history

The manager feeds a `UsageStore` from its own event stream and one router hook: every `request.finished` adds a request record (time, `durationMs`, the input / output / cache-read token counts the provider reported, when it reported them), every `profile.parked` adds a park (time, signal kind, `until`), and `Router.onUsage()` (called after each usage snapshot a lane reports is stored) adds a utilisation sample (time, `utilisation`, `resetAt`) when the snapshot carries a utilisation. No prompt text, output, secret, title or email is ever recorded. The stores prune on write: every write drops records older than 14 days from every profile (so an idle profile ages out too), then trims the written profile's oldest records until at most 5000 remain. `UsageStore.flush()` is optional; `close()` calls it once the last usage write has landed. `usageReport()` and `close()` first await `Router.settleUsage()`, which resolves once every usage snapshot a lane has reported is stored and recorded, so a report taken right after a request (even one that failed after its headers carried usage) sees that request's sample. Deleting a profile deletes its history.

`IronProxy.usageReport()` builds, per profile, requests and tokens for the last 1h / 5h / 24h / 7d, parks in the last 7 days and the last park time, the latest utilisation of the **current window** (samples sharing the latest sample's `resetAt` while that is still ahead, or, without a `resetAt`, samples from the last hour), and an estimate of the minutes left at this pace. The estimate is a least-squares line through the current window's samples: at least three samples and a positive slope, `minutesLeft = (1 - latest) / slopePerMinute`, capped at the minutes until `resetAt`; `confidence: 'medium'` with six or more samples spanning ten minutes or more, else `'low'`. With fewer samples, a flat or falling trend, or a stale window there is no estimate at all. It reads local history only; nothing is fetched to build it.

## Errors and hints

Every failure is an `IronProxyError` with a stable `code`, `retryable`, `details` and a `hint`: one imperative sentence telling the user what to do next. `DEFAULT_HINTS` covers every code; raisers that know more (the provider, the profile title, the missing binary's install command, the local reset time) pass their own. Hints pass through `sanitizeHint` (secret redaction plus email scrubbing) in the constructor, so nothing a caller puts in one can leak a key or an address. `toJSON()` / `serializeError()` carry the hint to events, the proxy's `iron` error object, the Electron bridge and the React banner.

## Extension points

- **New provider**: register a `ProviderAdapter` with `registry.register(...)`. An OpenAI-compatible API needs only a base URL.
- **New CLI**: write a `CliSpec` and wrap it in `new CliLane(spec)`. About sixty lines. Add `defaultHome(env)` only once the CLI's default state directory is verified, so its existing logins can be adopted.
- **OAuth lane**: implement `Lane` with `kind: 'oauth'`, call `registry.addLane(provider, lane)`, create profiles with `lane: 'oauth', oauth: { extension: '<your name>' }`.
- **Storage**: implement `ProfileStore`, `StateStore`, `UsageStore` or `Vault`. Memory versions ship for tests.
- **Key protection**: implement `KeyProtector` (two functions). The Electron package ships the `safeStorage` one.
- **Notifications**: `@iron-proxy/electron`'s `createNotifier` listens to the IronEvent stream and shows Electron notifications; `notificationFor(event, ctx)` is the pure event -> title/body mapping for hosts with their own notification UI. Titles and provider names only.

## What is deliberately not here

- No marketplace, plugin loader, or dynamic code loading. Adapters are imported.
- No telemetry. Events go to your listeners and nowhere else.
- No cross-provider fallback. That decision belongs to the host and its user.
- No token extraction from vendor files. The subscription lane drives the vendor CLI; it does not impersonate it.
