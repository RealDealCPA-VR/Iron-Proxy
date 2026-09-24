---
'@iron-proxy/core': patch
'iron-proxy': patch
---

Safer deletes, faster discovery, and small fixes from the wave A review.

- `updateProfile` (and `PATCH /iron/profiles/:id`) ignores `cli.adopted` in a patch and ignores `cli.home` for an adopted profile, so a patch can no longer turn an adopted login into one Iron-Proxy would delete. `deleteProfile` removes a home only when it is not adopted and lies strictly inside `<dataDir>/cli-homes` (never that folder itself, never a sibling such as `cli-homes-old`; case-insensitive on Windows). A child whose name only begins with `..` (such as `..cache`) still counts as inside.
- `discoverLogins()` runs the vendor status commands in parallel; results keep a fixed provider order. New `IronProxy.defaultCliHome(provider)`; `iron-proxy profiles adopt <provider>` without `--home` looks only at that provider's default home and runs no other CLI.
- `which()` on Windows treats a name as already having an extension only when that extension is in PATHEXT, so `my.tool` finds `my.tool.cmd`. The decision is exported as `candidateExtensions(binary, platform, pathext)`.
- The `NO_PROFILE` hint reads "Add an account for <provider>: …".
- `iron-proxy setup` no longer loses answers piped in on several lines at once. On a terminal the question is readline's own prompt, so a backspace redraw repaints the question rather than `> `.
- `iron-proxy run` / `env` with `--profile` print a stderr note when that account is parked (`Note: "<title>" is parked until <local time>; it may refuse requests.`) or signed out (`Note: "<title>" is not signed in: iron-proxy login <id>`).
- README: the bash `eval` example passes `--shell bash`, since `env` prints PowerShell lines by default on Windows.
