---
name: Bug report
about: Something behaves differently from the docs
labels: bug
---

**Package and version**
e.g. `@iron-proxy/core 0.1.0`, Node 22, Windows 11

**Provider and lane**
e.g. Anthropic / subscription (Claude Code 2.1.x)

**What happened**

**What you expected**

**Minimal reproduction**
A test against the fake CLI or an injected `fetch` is ideal. Never paste API keys, tokens, or the contents of `vault.json`, `vault.key`, or a CLI home directory.

**Events / errors**
The `IronEvent`s or the error `code` and message. The library redacts secrets, but check before posting.
