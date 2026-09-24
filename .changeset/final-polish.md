---
'@iron-proxy/core': patch
'@iron-proxy/proxy': patch
'@iron-proxy/electron': patch
'@iron-proxy/react': patch
---

Final polish from the wave review.

- Store lock files: two waiters that both find a stale lock (left by a crashed process) no longer both take it over. Only the waiter holding `<file>.lock.takeover` removes a stale lock; it checks the lock again, renames it to a name of its own (`<file>.lock.stale-<token>`) and deletes that, and a rename that finds nothing means someone else was first, so it tries again. Tested with real processes racing on a stale lock.
- Notifications: a switch is kept quiet after its park only when that park was shown because it reached the `maxHoldMs` cap. A park shown after the ordinary `coalesceMs` wait no longer swallows a later switch, which shows `Switched to ...`.
- The top-level `types` of `@iron-proxy/core`, `@iron-proxy/proxy`, `@iron-proxy/electron` and `@iron-proxy/react` now names the CommonJS declarations (`.d.cts`) that match their CommonJS `main`, for resolvers that do not read `exports`.
- Tray app: changing the port while the proxy it was sharing has gone away starts its own proxy once on the new port, instead of starting it and then restarting it.
