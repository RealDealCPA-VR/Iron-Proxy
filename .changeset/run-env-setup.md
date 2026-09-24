---
'@iron-proxy/core': minor
'iron-proxy': minor
---

Use your accounts from your own terminal, and a guided first run.

- `IronProxy.pickProfile(provider, { profileId?, lane? })`: the account a request would try first right now (enabled, cli lane by default, not parked, signed in, lowest order), clearing expired parks through the router's own `Router.availability()` check. Throws `NoProfileError`, `AllProfilesExhaustedError` (earliest reset) or `AuthRequiredError`; a pinned profile that is not a cli account of that provider is `INVALID_REQUEST`. New `IronProxy.interactiveCommand(id, args)` / `shellEnv(id)` and `CliLane.interactiveCommand()` / `shellEnv()`; `PROVIDER_SHORT_NAMES` is exported.
- `iron-proxy run <provider> [--profile id] [-- args]` starts the vendor CLI interactively as that account (home variable set, `*_API_KEY` removed, exit code passed through; a Windows `.cmd` shim runs through `cmd.exe /d /s /c` with escaped arguments). `iron-proxy env <provider> [--shell bash|powershell|cmd]` prints the lines that make your own shell use it. A session cannot switch accounts mid-session; the next `run` picks the next ready account.
- `iron-proxy setup [--yes]`: shows which vendor CLIs are installed (with the official install command for each missing one), adopts signed-in logins it finds, adds more accounts (headless sign-in, or an API key read without echo), and prints the status table.
- `which()` on Windows now resolves a bare name through PATHEXT only, so it finds `claude.cmd` instead of the extensionless sh script npm installs beside it.
- An empty `apiKey.secretRef` on `createProfile` now gets the generated `apikey:<id>` ref instead of being stored as `''`.
