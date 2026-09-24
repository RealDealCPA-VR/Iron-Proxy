---
'@iron-proxy/core': minor
'@iron-proxy/proxy': minor
'@iron-proxy/electron': minor
'@iron-proxy/react': minor
'iron-proxy': minor
---

Usage history and time-left estimates.

- **Core.** New `UsageStore` with `MemoryUsageStore` and `FileUsageStore` (`<dataDir>/usage.json`, atomic, debounced writes, pruned on write to 14 days and at most 5000 records per profile). The manager records every `request.finished` (time, duration, input / output / cache-read tokens when reported), every `profile.parked` (time, kind, until) and every utilisation sample a lane reports (time, utilisation, resetAt), through the new `Router.onUsage()` hook. Counts and timestamps only: no prompt text, output, secrets or emails. `IronProxyOptions.usage` swaps the store; `close()` flushes it; deleting a profile deletes its history.
- **`IronProxy.usageReport({ profileId? })`** returns one `UsageReport` per profile: requests and tokens for `1h` / `5h` / `24h` / `7d`, `parks7d`, `lastParkedAt`, the current window's `utilisation` / `resetAt`, and `estimate: { minutesLeft, basis: 'utilisation-trend', confidence }` only when at least three samples of the current window show a rising trend (`minutesLeft = (1 - latest) / slopePerMinute`, capped at the reset; `medium` with six samples over ten minutes, else `low`). New exports `buildUsageReport`, `estimateTimeLeft`, `currentWindowSamples`, `pruneUsageHistory` and their constants.
- **`IronClient.usageReport(profileId?)`** everywhere: `LocalIronClient`, the proxy route `GET /iron/usage[?profileId=]` with `HttpIronClient.usageReport()`, and the Electron bridge.
- **CLI.** `iron-proxy usage [--json] [--profile id]`: title, provider, requests and tokens for 5h / 24h / 7d, parks this week, `about N min left at this pace` (`(rough)` for a low-confidence estimate).
- **React.** `useUsageReport(client, { refreshMs?, debounceMs?, profileId? })` and `<UsagePanel client />` (request bars for 5h / 24h / 7d, tokens and parks this week, "About 40 min left at this pace" / "rough estimate"), and a **Usage** toggle in the `AccountSwitcher` header that shows the panel inside the switcher. New `usage*` labels and `formatCount`.
