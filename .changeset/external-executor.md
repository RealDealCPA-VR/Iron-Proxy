---
'@iron-proxy/core': minor
'@iron-proxy/proxy': minor
'iron-proxy': minor
---

External-executor API: a host that runs the vendor CLI itself can use Iron-Proxy as its account manager.

- `GET /iron/pick?provider=<id>[&lane=cli]` answers `{ profile, env: { set, unset } }`: the account a request would use right now and the variables that run its vendor CLI as that account (`env` is null for a non-cli pick). Errors keep the `/iron/*` shape; `NO_PROFILE` (404), `ALL_PROFILES_EXHAUSTED` (429, `details.resetAt` = the earliest reset, plus `retry-after`) and `AUTH_REQUIRED` (401, `details.profileId` and `details.title`) tell the three cases apart.
- `POST /iron/profiles/:id/signal` (`{ status?, headers?, text? }`) and `IronProxy.reportSignal(id, input)`: Iron-Proxy classifies the failure with its own detectors and parks the account through the router's own park path (same event, usage park record and state as an internal park). Answers `{ parked: true, signal, state }` or `{ parked: false }`.
- `POST /iron/profiles/:id/finished` (`{ usage?, durationMs?, model? }`) and `IronProxy.reportFinished(id, input)`: records the success exactly like an internal one (active, `served`, `request.finished` with the new optional `model`, a usage record), via the new `Router.recordServed()`.
- `HttpIronClient.pick / signal / finished` (not on `IronClient`). Bad bodies are `INVALID_REQUEST` (400).
- `AllProfilesExhaustedError.details.resetAt` and `AuthRequiredError.details.title` (when the title is known) are new.
- Fix: `detectFromHttp` no longer treats a 403 about the request (`permission_error`, "does not have access to this model", "Request not allowed") as an expired login, so a healthy account is not parked. A 401, and a 403 typed `authentication_error` or worded like an expired, revoked or invalid token, are still `auth-expired`.
- CLI: `iron-proxy --version`; `serve` creates a missing data directory; `pnpm --filter iron-proxy bundle` writes the whole CLI as one dependency-free file, `packages/cli/dist-bundle/iron-proxy.mjs`, that runs under Node and under Electron as Node (not published).
