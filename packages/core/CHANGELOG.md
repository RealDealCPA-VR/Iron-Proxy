# @iron-proxy/core

## 0.2.0

### Minor Changes

- 4ba45db: Adopt existing logins and actionable hints on every error.

  - `discoverLogins()` finds Claude Code, Codex and Grok CLIs already signed in at their default homes (`CLAUDE_CONFIG_DIR` / `~/.claude`, `CODEX_HOME` / `~/.codex`, `GROK_HOME` / `~/.grok`) using each CLI's own status command; `adoptLogin({ provider, home, title? })` turns one into a profile that uses the directory in place (`cli.adopted: true`). Adopted homes are never prepared, recreated or deleted. New `CliSpec.defaultHome(env)` and `IronProxyOptions.env`. Exposed on `IronClient`, the proxy (`GET /iron/discover`, `POST /iron/adopt`), the Electron bridge, the CLI (`profiles discover`, `profiles adopt`) and the React switcher ("Found on this computer", "Existing login" badge, confirm before logging out an adopted login).
  - `IronProxyError.hint` and `SerializedError.hint`: one sentence telling the user what to do next, for every error code (including the official install command when a vendor CLI is missing), scrubbed of secrets and emails. Printed by the CLI, returned in proxy error bodies (`iron.hint`), carried by `HttpIronClientError` and `IronBridgeError`, and shown by the React `ErrorBanner`.

- ca1665a: Initial release: core engine (profiles, encrypted vault, Anthropic / OpenAI / Google / xAI / OpenAI-compatible adapters, vendor-CLI subscription lane, ordered same-provider failover with automatic return), local proxy with OpenAI- and Anthropic-compatible endpoints, Electron bridge with safeStorage key protection, styled React account switcher, and the `iron-proxy` command line.
- 2bdab9a: Switch before the wall, and continue a cut-off answer.

  - **Pre-emptive switching.** New `FailoverPolicy.preemptAtUtilisation` (default `0.95`, per-provider overridable, `>= 1` turns it off). An account whose last usage snapshot is at least that full, with its `resetAt` still ahead, is tried after the others for that request. Nothing is parked or persisted; if every account is hot the normal order stands; a pinned request is never reordered. Usage whose reset has passed (or, without a reset, older than ten minutes) is ignored. When an early switch changes the active account, `profile.switched` carries a reason with the new `QuotaSignal.source` value `'usage'` and a message like `Switched early: 96% of the window used, resets 3:40 PM`. New exports `isUsageHot`, `isUsageFresh`, `USAGE_STALE_MS`.
  - **Opt-in resume.** New `FailoverPolicy.resumeInterrupted` (default `false`) and `RunOptions.resumeInterrupted`. When a stream hits a limit after text was sent and no tool call is open, the account is parked and the next ready account of the same provider continues the answer from the partial text (an assistant turn plus `Continue exactly where you stopped. Do not repeat any text you already wrote.`; the Anthropic API lane gets a trimmed assistant prefill instead). The caller sees one `start`, the text, a `switched` event with the new `resumed: true`, then the continuation. Chains across accounts; ends with `STREAM_INTERRUPTED` when nobody is left. New exports `continuationRequest`, `CONTINUE_INSTRUCTION`. Off by default because the join can occasionally show a seam.
  - The Anthropic API lane treats a mid-stream `rate_limit_error` / `overloaded_error` event as a quota signal.
  - `profile.switched` after a signal-driven failover now carries the signal as `reason`, as docs/FAILOVER.md always described.
  - Usage reported by a lane is written before the router's own state write for that account, so a snapshot is never lost to a race.
  - Proxy: request header `x-iron-resume: 1` (both `/v1/chat/completions` and `/v1/messages`; `0` opts out of a policy default); the switch comment reads `iron switched <from> -> <to> resumed`.
  - CLI: `iron-proxy chat --resume`; `profiles adopt <provider>` checks that one profile's sign-in after adopting and prints `Note: "<title>" is not signed in yet: iron-proxy login <id>` on stderr when it is signed out.
  - `deleteProfile` never removes a home another stored profile also uses or that contains another profile's home; `updateProfile` rejects a `cli.home` another profile already uses (`INVALID_REQUEST` with a hint).

- 4ba45db: Use your accounts from your own terminal, and a guided first run.

  - `IronProxy.pickProfile(provider, { profileId?, lane? })`: the account a request would try first right now (enabled, cli lane by default, not parked, signed in, lowest order), clearing expired parks through the router's own `Router.availability()` check. Throws `NoProfileError`, `AllProfilesExhaustedError` (earliest reset) or `AuthRequiredError`; a pinned profile that is not a cli account of that provider is `INVALID_REQUEST`. New `IronProxy.interactiveCommand(id, args)` / `shellEnv(id)` and `CliLane.interactiveCommand()` / `shellEnv()`; `PROVIDER_SHORT_NAMES` is exported.
  - `iron-proxy run <provider> [--profile id] [-- args]` starts the vendor CLI interactively as that account (home variable set, `*_API_KEY` removed, exit code passed through; a Windows `.cmd` shim runs through `cmd.exe /d /s /c` with escaped arguments). `iron-proxy env <provider> [--shell bash|powershell|cmd]` prints the lines that make your own shell use it. A session cannot switch accounts mid-session; the next `run` picks the next ready account.
  - `iron-proxy setup [--yes]`: shows which vendor CLIs are installed (with the official install command for each missing one), adopts signed-in logins it finds, adds more accounts (headless sign-in, or an API key read without echo), and prints the status table.
  - `which()` on Windows now resolves a bare name through PATHEXT only, so it finds `claude.cmd` instead of the extensionless sh script npm installs beside it.
  - An empty `apiKey.secretRef` on `createProfile` now gets the generated `apikey:<id>` ref instead of being stored as `''`.

- 2bdab9a: Usage history and time-left estimates.

  - **Core.** New `UsageStore` with `MemoryUsageStore` and `FileUsageStore` (`<dataDir>/usage.json`, atomic, debounced writes, pruned on write to 14 days and at most 5000 records per profile). The manager records every `request.finished` (time, duration, input / output / cache-read tokens when reported), every `profile.parked` (time, kind, until) and every utilisation sample a lane reports (time, utilisation, resetAt), through the new `Router.onUsage()` hook. Counts and timestamps only: no prompt text, output, secrets or emails. `IronProxyOptions.usage` swaps the store; `close()` flushes it; deleting a profile deletes its history.
  - **`IronProxy.usageReport({ profileId? })`** returns one `UsageReport` per profile: requests and tokens for `1h` / `5h` / `24h` / `7d`, `parks7d`, `lastParkedAt`, the current window's `utilisation` / `resetAt`, and `estimate: { minutesLeft, basis: 'utilisation-trend', confidence }` only when at least three samples of the current window show a rising trend (`minutesLeft = (1 - latest) / slopePerMinute`, capped at the reset; `medium` with six samples over ten minutes, else `low`). New exports `buildUsageReport`, `estimateTimeLeft`, `currentWindowSamples`, `pruneUsageHistory` and their constants.
  - **`IronClient.usageReport(profileId?)`** everywhere: `LocalIronClient`, the proxy route `GET /iron/usage[?profileId=]` with `HttpIronClient.usageReport()`, and the Electron bridge.
  - **CLI.** `iron-proxy usage [--json] [--profile id]`: title, provider, requests and tokens for 5h / 24h / 7d, parks this week, `about N min left at this pace` (`(rough)` for a low-confidence estimate).
  - **React.** `useUsageReport(client, { refreshMs?, debounceMs?, profileId? })` and `<UsagePanel client />` (request bars for 5h / 24h / 7d, tokens and parks this week, "About 40 min left at this pace" / "rough estimate"), and a **Usage** toggle in the `AccountSwitcher` header that shows the panel inside the switcher. New `usage*` labels and `formatCount`.

### Patch Changes

- 7246b97: Ready for npm: every package now ships its README and the MIT LICENSE in the tarball, publishes with npm provenance, links its repository, homepage and issue tracker, and gives CommonJS consumers their own type declarations (`exports[...].require.types` points at `.d.cts`, `import.types` at `.d.ts`). `pnpm pack:check` checks each tarball's contents before any publish.

  Also in this release, not published to npm: the tray app (`apps/tray`) builds installers with electron-builder (Windows NSIS x64 and arm64, macOS dmg and zip for Intel and Apple silicon, Linux AppImage and deb) in a new tag-triggered workflow that attaches them with SHA256SUMS.txt to a GitHub Release. The builds are not code-signed yet; apps/tray/README.md has the first-launch steps. winget and Homebrew manifests live in `packaging/`, and docs/RELEASING.md describes every release step.

- a1c1dbd: Final polish from the wave review.

  - Store lock files: two waiters that both find a stale lock (left by a crashed process) no longer both take it over. Only the waiter holding `<file>.lock.takeover` removes a stale lock; it checks the lock again, renames it to a name of its own (`<file>.lock.stale-<token>`) and deletes that, and a rename that finds nothing means someone else was first, so it tries again. Tested with real processes racing on a stale lock.
  - Notifications: a switch is kept quiet after its park only when that park was shown because it reached the `maxHoldMs` cap. A park shown after the ordinary `coalesceMs` wait no longer swallows a later switch, which shows `Switched to ...`.
  - The top-level `types` of `@iron-proxy/core`, `@iron-proxy/proxy`, `@iron-proxy/electron` and `@iron-proxy/react` now names the CommonJS declarations (`.d.cts`) that match their CommonJS `main`, for resolvers that do not read `exports`.
  - Tray app: changing the port while the proxy it was sharing has gone away starts its own proxy once on the new port, instead of starting it and then restarting it.

- b7391ae: A status check that finishes after a park no longer undoes the park, and `close()` waits for background status checks so nothing is written to `state.json` after it returns.
- 139329a: The file profile and state stores now notice when another process on the same data directory changed their file (the CLI, a running `iron-proxy serve`, or the new tray app) and re-read it, so an account added in one shows up in the others and a later write no longer drops it. The state store never re-reads over a write of its own that is still pending.

  Also in this release, not published to npm: `apps/tray`, a ready-made desktop tray app for people who do not write code. It shares its accounts with the `iron-proxy` CLI, runs (or reuses) the local proxy, shows each provider's accounts with the one in use marked, switches with a click, copies the OpenAI and Anthropic base URLs, and sends desktop notifications. Installers come in a later release.

- 6a2e087: Safer deletes, faster discovery, and small fixes from the wave A review.

  - `updateProfile` (and `PATCH /iron/profiles/:id`) ignores `cli.adopted` in a patch and ignores `cli.home` for an adopted profile, so a patch can no longer turn an adopted login into one Iron-Proxy would delete. `deleteProfile` removes a home only when it is not adopted and lies strictly inside `<dataDir>/cli-homes` (never that folder itself, never a sibling such as `cli-homes-old`; case-insensitive on Windows). A child whose name only begins with `..` (such as `..cache`) still counts as inside.
  - `discoverLogins()` runs the vendor status commands in parallel; results keep a fixed provider order. New `IronProxy.defaultCliHome(provider)`; `iron-proxy profiles adopt <provider>` without `--home` looks only at that provider's default home and runs no other CLI.
  - `which()` on Windows treats a name as already having an extension only when that extension is in PATHEXT, so `my.tool` finds `my.tool.cmd`. The decision is exported as `candidateExtensions(binary, platform, pathext)`.
  - The `NO_PROFILE` hint reads "Add an account for <provider>: …".
  - `iron-proxy setup` no longer loses answers piped in on several lines at once. On a terminal the question is readline's own prompt, so a backspace redraw repaints the question rather than `> `.
  - `iron-proxy run` / `env` with `--profile` print a stderr note when that account is parked (`Note: "<title>" is parked until <local time>; it may refuse requests.`) or signed out (`Note: "<title>" is not signed in: iron-proxy login <id>`).
  - README: the bash `eval` example passes `--shell bash`, since `env` prints PowerShell lines by default on Windows.

- 139329a: Small fixes from the wave B review.

  - `iron-proxy profiles adopt` runs the vendor CLI's status check once, not twice: `adoptLogin()` already checks, and the CLI reads the stored state. The stderr "not signed in yet" note is unchanged.
  - Resuming a cut-off stream when the caller's request already ends with an assistant turn (a prefill) adds the partial text to that turn on every lane, so a continuation never has two assistant turns in a row; lanes other than the Anthropic API still get the continue instruction after it.
  - New `Router.settleUsage()`, which resolves once every usage snapshot a lane reported is stored and recorded. `IronProxy.usageReport()` and `close()` await it, so a report taken right after a request (even a failed one whose headers carried usage) includes its sample.
  - `UsageStore` has an optional `flush(): Promise<void>`, which `close()` calls after the last usage write.
  - Usage stores age out every profile on every write, so an idle profile's records older than 14 days are dropped too (the 5000-record trim still applies to the profile being written).
  - React: `<UsagePanel>` shows the error banner (message, code, hint) when `usageReport` fails, instead of "No usage recorded yet." `<ErrorBanner>` takes an optional `labels` prop and works outside `<AccountSwitcher>`.
  - Docs: pre-emptive switching applies to accounts whose lane reports a usage window, today the API-key lanes via rate-limit headers; subscription (CLI) accounts switch on the vendor's own limit message.

- 7246b97: Small fixes from the wave C review.

  - Several processes on one data directory (the tray app, the CLI, a running `serve`) no longer drop each other's changes. `FileProfileStore`, `FileStateStore` and `FileUsageStore` write under a lock file next to the data file (`<file>.lock`, created exclusively, retried for up to about 2 s, removed as stale after 10 s), re-read the file and apply only this process's own changes (profiles or states put, ids deleted, usage records appended since the last write) before the atomic write. A read re-loads the file when it changed on disk, with this process's unsaved changes on top. A profile added in the tray survives the CLI's next write, a park is not lost, a delete is not brought back, and usage records from every process add up. The stores take an optional `lock: { timeoutMs?, staleMs? }` and expose `externalWrites`, the number of file versions written by another process they have read.
  - Atomic JSON writes retry a rename Windows briefly refuses while another process has the file open.
  - Notifications: when a park was already shown because the next account took longer than `maxHoldMs` to answer, the switch that follows is kept quiet if that park was shown within `throttleMs`, so one incident still makes one notification.
