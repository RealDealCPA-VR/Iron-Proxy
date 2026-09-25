---
'@iron-proxy/core': patch
---

A status check that finishes after a park no longer undoes the park, and `close()` waits for background status checks so nothing is written to `state.json` after it returns.
