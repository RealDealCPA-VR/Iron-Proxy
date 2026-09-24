---
'@iron-proxy/core': patch
---

The file profile and state stores now notice when another process on the same data directory changed their file (the CLI, a running `iron-proxy serve`, or the new tray app) and re-read it, so an account added in one shows up in the others and a later write no longer drops it. The state store never re-reads over a write of its own that is still pending.

Also in this release, not published to npm: `apps/tray`, a ready-made desktop tray app for people who do not write code. It shares its accounts with the `iron-proxy` CLI, runs (or reuses) the local proxy, shows each provider's accounts with the one in use marked, switches with a click, copies the OpenAI and Anthropic base URLs, and sends desktop notifications. Installers come in a later release.
