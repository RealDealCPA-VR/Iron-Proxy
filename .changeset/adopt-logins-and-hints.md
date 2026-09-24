---
'@iron-proxy/core': minor
'@iron-proxy/proxy': minor
'@iron-proxy/electron': minor
'@iron-proxy/react': minor
'iron-proxy': minor
---

Adopt existing logins and actionable hints on every error.

- `discoverLogins()` finds Claude Code, Codex and Grok CLIs already signed in at their default homes (`CLAUDE_CONFIG_DIR` / `~/.claude`, `CODEX_HOME` / `~/.codex`, `GROK_HOME` / `~/.grok`) using each CLI's own status command; `adoptLogin({ provider, home, title? })` turns one into a profile that uses the directory in place (`cli.adopted: true`). Adopted homes are never prepared, recreated or deleted. New `CliSpec.defaultHome(env)` and `IronProxyOptions.env`. Exposed on `IronClient`, the proxy (`GET /iron/discover`, `POST /iron/adopt`), the Electron bridge, the CLI (`profiles discover`, `profiles adopt`) and the React switcher ("Found on this computer", "Existing login" badge, confirm before logging out an adopted login).
- `IronProxyError.hint` and `SerializedError.hint`: one sentence telling the user what to do next, for every error code (including the official install command when a vendor CLI is missing), scrubbed of secrets and emails. Printed by the CLI, returned in proxy error bodies (`iron.hint`), carried by `HttpIronClientError` and `IronBridgeError`, and shown by the React `ErrorBanner`.
