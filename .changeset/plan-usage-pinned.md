---
'@iron-proxy/core': minor
'@iron-proxy/proxy': minor
---

Plan and usage per account, and a pinned pick.

- Account states carry the subscription `plan` (`planSource`, `planAt`) and `windows: [{ kind, usedPercent, windowMins?, resetsAt?, source, at }]`, the latest reading per window (a window whose reset has passed is left out). Learned without any model call: Claude Code's own `claude auth status` (`subscriptionType`, read by the status check `refreshStatus` already runs), the `anthropic-ratelimit-unified-5h-*` / `-7d-*` headers a host forwards on `/signal` and now `/finished` (`headers`), and a Codex rate-limit snapshot a host reports as `rateLimits` on either route (`planType`, `primary`, `secondary`). Signing out (or in) forgets them.
- A `/signal` limit that names no reset parks until the reset of the window the same report says is used up.
- `anthropic-ratelimit-unified-reset` is read as the unix seconds Anthropic sends (it was read as an RFC 3339 date, so a Claude subscription 429 fell back to the default cooldown), and only while `anthropic-ratelimit-unified-status` is `rejected` (no overage serving): a 429 with an `allowed` status keeps its own retry-after instead of parking until the window ends.
- `GET /iron/pick?…&pinned=1` requires `profileId` (a 400 otherwise, never the next ready account) and answers exactly as a `profileId` pick. `HttpIronClient.pick(provider, { pinned })`. `GET /iron/health` `features` adds `"pick-pinned"` and `"plan-usage"`.
