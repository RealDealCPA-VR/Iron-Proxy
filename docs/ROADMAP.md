# Roadmap and work list

The build plan Iron-Proxy was scaffolded from, kept current. Checked items exist in this repository with tests. Unchecked items are the path to 1.0 and beyond. Each unchecked item is small enough to be one pull request.

## 0. Decisions (settled)

- [x] Auth model: three pluggable lanes. Subscription = official vendor CLI in an isolated home; API key = vaulted key; OAuth = interface only.
- [x] Delivery: TypeScript library + optional localhost proxy + Electron bridge + styled React switcher + CLI.
- [x] Providers v1: Anthropic, OpenAI, Google, xAI (Grok Build CLI inherited), generic OpenAI-compatible.
- [x] Secrets: AES-256-GCM file vault, master key protected by Electron `safeStorage` when available; no passphrase prompts ("click and continue").
- [x] Failover: ordered, same-provider, cooldown from provider reset data, automatic return, never cross-provider.
- [x] License MIT, GitHub org RealDealCPA-VR, monorepo with pnpm + changesets.

## 1. Core engine (`@iron-proxy/core`)

- [x] Domain model: Profile / ProfileState / QuotaSignal / UnifiedRequest / StreamEvent / IronEvent / FailoverPolicy.
- [x] Typed error hierarchy with stable `code`s and JSON serialisation.
- [x] Typed event emitter; listener errors never propagate.
- [x] Profile store and state store: memory + atomic JSON file versions, debounced state writes.
- [x] Vault: memory + AES-256-GCM file vault, per-entry IV, ref bound as AAD, pluggable `KeyProtector`.
- [x] Quota detection from HTTP (status, Anthropic/OpenAI/Google headers and bodies) and from CLI output (broad patterns, reset-time parsing).
- [x] Wire translators: unified ⇄ OpenAI Chat Completions, unified ⇄ Anthropic Messages, unified → Gemini generateContent, streaming both directions where the proxy needs it.
- [x] API-key lanes: Anthropic, OpenAI-compatible (OpenAI, xAI, generic), Google. Streaming, tools, images, usage headers.
- [x] CLI lane: spec-driven runner, scrubbed environment, isolated home, line-streamed parsing, login session with URL/code capture, logout, status, models.
- [x] CLI specs: Claude Code, Codex CLI, Grok Build CLI, Gemini CLI.
- [x] Router: ordered same-provider failover, parking, auto-return, overload retry, pinning/strict, silent pre-content stream switch, `STREAM_INTERRUPTED`, `ALL_PROFILES_EXHAUSTED` with earliest reset.
- [x] Manager facade: profile CRUD, reorder/activate, API-key set, login/logout/refresh, unpark, models, doctor, close.
- [x] `IronClient` contract + `LocalIronClient`.
- [x] 99 tests incl. a fake vendor CLI exercising all four flavours through the real spawn path.
- [x] Switch before the wall: accounts whose fresh usage is at or above `preemptAtUtilisation` (default 95%) go last for the request, nothing parked; `profile.switched` reason with `source: 'usage'`. Applies to lanes that report a usage window (today the API-key lanes, from rate-limit headers).
- [ ] Pre-emptive switching for subscription (CLI) accounts, once a vendor CLI reports its usage window in its own output (no polling, no reading its credential files).
- [x] Opt-in resume of a stream cut off mid-answer (`resumeInterrupted`, `x-iron-resume: 1`, `chat --resume`): the next account continues from the partial text; Anthropic API gets a trimmed assistant prefill.
- [ ] Multi-turn for the CLI lane via Claude's `--input-format stream-json` and Codex `exec resume`, instead of transcript flattening.
- [ ] Optional cheap liveness probe when a park expires (opt-in; default stays "no background probing").
- [ ] Per-profile concurrency limit and request queue.
- [x] Usage history per profile (`UsageStore`, `<dataDir>/usage.json`, 14 days / 5000 records, counts only): requests and tokens for 1h / 5h / 24h / 7d, parks this week, and a time-left estimate from the utilisation trend (`IronProxy.usageReport()`).
- [x] File profile and state stores re-read a file another process changed (the CLI, a running `serve` and the tray app share one data directory); a pending state write is never overwritten by a re-read.
- [ ] Usage accounting per profile per window surfaced in `ProfileState.usage` even for providers without headers (the history counts requests and tokens; it does not know the plan's limits).
- [ ] Time-left estimate from token burn for providers that report no utilisation.
- [x] Adopt existing logins: `discoverLogins()` finds a signed-in `~/.claude`, `~/.codex`, `~/.grok` (or their home variables) via the CLI's own status command, and `adoptLogin()` uses that directory in place (`cli.adopted`), never copying or deleting it.
- [ ] Adopt existing Gemini CLI logins once its default home layout is verified.
- [x] Actionable `hint` on every error (`IronProxyError.hint`, `SerializedError.hint`), sanitised of secrets and emails, with the official install command for a missing vendor CLI.
- [ ] Pluggable logger interface (currently silent by design).

## 2. Local proxy (`@iron-proxy/proxy`)

- [x] Loopback HTTP server, bearer-token control API, OpenAI + Anthropic compatible model routes, SSE streaming, `/v1/models`, `/iron/events` SSE, error mapping incl. `retry-after`.
- [x] `HttpIronClient` implementing `IronClient` with SSE reconnect.
- [x] `GET /iron/discover`, `POST /iron/adopt`; error bodies carry `iron.hint`, and `HttpIronClientError.hint`.
- [x] `GET /iron/usage[?profileId=]` and `HttpIronClient.usageReport()`.
- [ ] Anthropic `count_tokens` and OpenAI `responses` endpoints.
- [ ] Optional Unix socket / named pipe listener.
- [ ] Request/response logging hook (redacted) for debugging.

## 3. Electron (`@iron-proxy/electron`)

- [x] `createElectronIronProxy` (userData dir, `safeStorage` key protector), `installIronProxy` IPC dispatcher with method whitelist, preload `exposeIronProxy`, renderer `getIronClient`, `openLoginTerminal` for win32/darwin/linux.
- [x] The bridge carries `discoverLogins` / `adoptLogin`, and `IronBridgeError.hint`.
- [x] The bridge carries `usageReport`.
- [x] Desktop notifications: `createNotifier({ iron | client, Notification })` for automatic switches, parked and exhausted accounts and sign-ins, with park -> switch coalescing, a per-account throttle and per-kind settings; the pure `notificationFor(event, ctx)` for custom UI.
- [ ] Auto-start and supervise the proxy as a child process from Electron (for hosts that want SDK compatibility inside the app).
- [ ] Deep-link return from browser login for CLIs that support a custom callback.

## 4. React (`@iron-proxy/react`)

- [x] `useIronProxy`, `useCountdown`, `<AccountSwitcher />` with add / title / reorder / toggle / login (URL + code) / usage bars / parked timers / exhausted banner, light + dark, keyboard accessible.
- [x] "Found on this computer" in Add account with one-click "Use this account"; "Existing login" badge; confirm before logging out an adopted login; hints under error messages.
- [x] `useUsageReport(client, { refreshMs })` and `<UsagePanel client />`: per-account request bars for 5h / 24h / 7d, tokens this week, parks this week, "About 40 min left at this pace"; a **Usage** toggle in the switcher header.
- [ ] Headless primitives export (`useAccountRow`, `useAddAccountFlow`) for fully custom UIs.
- [ ] Drag-and-drop reorder (pointer + keyboard).
- [ ] Storybook or a static gallery page for visual review.

## 5. CLI (`iron-proxy`)

- [x] `serve`, `profiles …`, `login`, `logout`, `status`, `doctor`, `models`, `chat`, `--json`.
- [x] `profiles discover [--json]`, `profiles adopt <provider> [--home DIR] [--title T]`; a `hint: …` line after every error.
- [x] `setup [--yes]`: guided first run (doctor, adopt found logins, add accounts, summary).
- [x] `run <provider> [--profile id] [-- args]` and `env <provider> [--shell bash|powershell|cmd]`: use the ready account from your own terminal (`IronProxy.pickProfile`).
- [x] `usage [--json] [--profile id]`: requests and tokens for 5h / 24h / 7d, parks this week, `about N min left at this pace`.
- [ ] Shell completions.
- [ ] `iron-proxy export/import` for moving profiles (never secrets) between machines.

## 5b. Tray app (`apps/tray`, private)

- [x] A ready-made Electron tray app for non-developers: one section per provider with a radio on the account serving next (click = activate), `parked until 3:40 PM` / `needs login` suffixes, tooltip `Iron-Proxy: Claude on "Work Claude Max"`, copy OpenAI / Anthropic base URLs, notifications submenu, start at login, quit.
- [x] Shares the CLI's data directory (`IRON_PROXY_DATA_DIR` or `~/.iron-proxy`) and file vault; watches `profiles.json` / `state.json` so accounts and parks written by the CLI or a running `serve` show up.
- [x] Starts the local proxy on 127.0.0.1:8791 (a setting; a free port when taken), writes and removes `proxy.json` like `serve`, and reuses a live `serve` instead of starting a second server.
- [x] Window (420x640, hidden on close) with the proxy URL, `<AccountSwitcher>` with terminal login through a checked IPC channel, the usage panel, and settings.
- [x] Pure, tested menu / settings / proxy-decision logic; the main-process wiring tested end to end with fake Electron modules; icons drawn by a zero-dependency script.
- [ ] Installers (Windows, macOS, Linux) built in the release workflow.
- [ ] Code signing and notarisation.
- [ ] Auto-update.
- [ ] Optional OS-keychain protection of the shared vault key that the CLI can also unlock.

## 6. Verification against real accounts

- [ ] Claude Code: live headless turn + live limit capture recorded in docs/PROVIDERS.md.
- [ ] Codex CLI: same.
- [ ] Grok Build CLI: same, and confirm the `streaming-messages-json` schema.
- [ ] Gemini CLI: install, confirm flags (`GEMINI_CLI_HOME`, `-p`, `--output-format stream-json`), record.
- [ ] One real 429 per API provider captured into fixtures.

## 7. Release engineering

- [x] CI matrix: Ubuntu / Windows / macOS × Node 20 / 22: typecheck, lint, test, build.
- [x] Changesets configured; release workflow publishes on `main` when changesets are present.
- [ ] `NPM_TOKEN` secret added to the repository and first publish of `0.1.0`.
- [ ] Provenance (`npm publish --provenance`) once the org is set up for it.
- [ ] Signed tags.

## 8. Documentation

- [x] README, ARCHITECTURE, ADOPTING, PROVIDERS, FAILOVER, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, per-package READMEs.
- [ ] A short screencast / GIF of the switcher failing over.
- [ ] Threat model write-up (what an attacker with disk access gets, and does not get).
