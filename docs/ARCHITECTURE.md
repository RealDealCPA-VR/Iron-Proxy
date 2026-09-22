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
  vault.json         AES-256-GCM entries, ref-bound AAD
  vault.key          master key; in Electron wrapped by safeStorage (DPAPI / Keychain / libsecret)
  cli-homes/<provider>/<profileId>/   isolated vendor CLI home per subscription account
  proxy.json         written by `iron-proxy serve`: {url, token, pid}
```

Default `dataDir` is `~/.iron-proxy` (or `IRON_PROXY_DATA_DIR`). Electron hosts get `<userData>/iron-proxy`. Two apps that want to _share_ accounts point at the same `dataDir`; two that want isolation do not.

## Extension points

- **New provider**: register a `ProviderAdapter` with `registry.register(...)`. An OpenAI-compatible API needs only a base URL.
- **New CLI**: write a `CliSpec` and wrap it in `new CliLane(spec)`. About sixty lines.
- **OAuth lane**: implement `Lane` with `kind: 'oauth'`, call `registry.addLane(provider, lane)`, create profiles with `lane: 'oauth', oauth: { extension: '<your name>' }`.
- **Storage**: implement `ProfileStore`, `StateStore` or `Vault`. Memory versions ship for tests.
- **Key protection**: implement `KeyProtector` (two functions). The Electron package ships the `safeStorage` one.

## What is deliberately not here

- No marketplace, plugin loader, or dynamic code loading. Adapters are imported.
- No telemetry. Events go to your listeners and nowhere else.
- No cross-provider fallback. That decision belongs to the host and its user.
- No token extraction from vendor files. The subscription lane drives the vendor CLI; it does not impersonate it.
