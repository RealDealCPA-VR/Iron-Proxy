# @iron-proxy/react

## 0.2.0

### Minor Changes

- 4ba45db: Adopt existing logins and actionable hints on every error.

  - `discoverLogins()` finds Claude Code, Codex and Grok CLIs already signed in at their default homes (`CLAUDE_CONFIG_DIR` / `~/.claude`, `CODEX_HOME` / `~/.codex`, `GROK_HOME` / `~/.grok`) using each CLI's own status command; `adoptLogin({ provider, home, title? })` turns one into a profile that uses the directory in place (`cli.adopted: true`). Adopted homes are never prepared, recreated or deleted. New `CliSpec.defaultHome(env)` and `IronProxyOptions.env`. Exposed on `IronClient`, the proxy (`GET /iron/discover`, `POST /iron/adopt`), the Electron bridge, the CLI (`profiles discover`, `profiles adopt`) and the React switcher ("Found on this computer", "Existing login" badge, confirm before logging out an adopted login).
  - `IronProxyError.hint` and `SerializedError.hint`: one sentence telling the user what to do next, for every error code (including the official install command when a vendor CLI is missing), scrubbed of secrets and emails. Printed by the CLI, returned in proxy error bodies (`iron.hint`), carried by `HttpIronClientError` and `IronBridgeError`, and shown by the React `ErrorBanner`.

- ca1665a: Initial release: core engine (profiles, encrypted vault, Anthropic / OpenAI / Google / xAI / OpenAI-compatible adapters, vendor-CLI subscription lane, ordered same-provider failover with automatic return), local proxy with OpenAI- and Anthropic-compatible endpoints, Electron bridge with safeStorage key protection, styled React account switcher, and the `iron-proxy` command line.
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

- 139329a: Small fixes from the wave B review.

  - `iron-proxy profiles adopt` runs the vendor CLI's status check once, not twice: `adoptLogin()` already checks, and the CLI reads the stored state. The stderr "not signed in yet" note is unchanged.
  - Resuming a cut-off stream when the caller's request already ends with an assistant turn (a prefill) adds the partial text to that turn on every lane, so a continuation never has two assistant turns in a row; lanes other than the Anthropic API still get the continue instruction after it.
  - New `Router.settleUsage()`, which resolves once every usage snapshot a lane reported is stored and recorded. `IronProxy.usageReport()` and `close()` await it, so a report taken right after a request (even a failed one whose headers carried usage) includes its sample.
  - `UsageStore` has an optional `flush(): Promise<void>`, which `close()` calls after the last usage write.
  - Usage stores age out every profile on every write, so an idle profile's records older than 14 days are dropped too (the 5000-record trim still applies to the profile being written).
  - React: `<UsagePanel>` shows the error banner (message, code, hint) when `usageReport` fails, instead of "No usage recorded yet." `<ErrorBanner>` takes an optional `labels` prop and works outside `<AccountSwitcher>`.
  - Docs: pre-emptive switching applies to accounts whose lane reports a usage window, today the API-key lanes via rate-limit headers; subscription (CLI) accounts switch on the vendor's own limit message.

- Updated dependencies [4ba45db]
- Updated dependencies [7246b97]
- Updated dependencies [a1c1dbd]
- Updated dependencies [ca1665a]
- Updated dependencies [2bdab9a]
- Updated dependencies [b7391ae]
- Updated dependencies [4ba45db]
- Updated dependencies [139329a]
- Updated dependencies [2bdab9a]
- Updated dependencies [6a2e087]
- Updated dependencies [139329a]
- Updated dependencies [7246b97]
  - @iron-proxy/core@0.2.0
