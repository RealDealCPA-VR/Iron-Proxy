---
'@iron-proxy/core': minor
'@iron-proxy/proxy': minor
'iron-proxy': minor
---

Switch before the wall, and continue a cut-off answer.

- **Pre-emptive switching.** New `FailoverPolicy.preemptAtUtilisation` (default `0.95`, per-provider overridable, `>= 1` turns it off). An account whose last usage snapshot is at least that full, with its `resetAt` still ahead, is tried after the others for that request. Nothing is parked or persisted; if every account is hot the normal order stands; a pinned request is never reordered. Usage whose reset has passed (or, without a reset, older than ten minutes) is ignored. When an early switch changes the active account, `profile.switched` carries a reason with the new `QuotaSignal.source` value `'usage'` and a message like `Switched early: 96% of the window used, resets 3:40 PM`. New exports `isUsageHot`, `isUsageFresh`, `USAGE_STALE_MS`.
- **Opt-in resume.** New `FailoverPolicy.resumeInterrupted` (default `false`) and `RunOptions.resumeInterrupted`. When a stream hits a limit after text was sent and no tool call is open, the account is parked and the next ready account of the same provider continues the answer from the partial text (an assistant turn plus `Continue exactly where you stopped. Do not repeat any text you already wrote.`; the Anthropic API lane gets a trimmed assistant prefill instead). The caller sees one `start`, the text, a `switched` event with the new `resumed: true`, then the continuation. Chains across accounts; ends with `STREAM_INTERRUPTED` when nobody is left. New exports `continuationRequest`, `CONTINUE_INSTRUCTION`. Off by default because the join can occasionally show a seam.
- The Anthropic API lane treats a mid-stream `rate_limit_error` / `overloaded_error` event as a quota signal.
- `profile.switched` after a signal-driven failover now carries the signal as `reason`, as docs/FAILOVER.md always described.
- Usage reported by a lane is written before the router's own state write for that account, so a snapshot is never lost to a race.
- Proxy: request header `x-iron-resume: 1` (both `/v1/chat/completions` and `/v1/messages`; `0` opts out of a policy default); the switch comment reads `iron switched <from> -> <to> resumed`.
- CLI: `iron-proxy chat --resume`; `profiles adopt <provider>` checks that one profile's sign-in after adopting and prints `Note: "<title>" is not signed in yet: iron-proxy login <id>` on stderr when it is signed out.
- `deleteProfile` never removes a home another stored profile also uses or that contains another profile's home; `updateProfile` rejects a `cli.home` another profile already uses (`INVALID_REQUEST` with a hint).
