---
'@iron-proxy/core': minor
'@iron-proxy/proxy': minor
---

Pick a given account: `GET /iron/pick?provider=<id>&profileId=<id>[&lane=cli]` answers `{ profile, env }` for exactly that account, or an error saying why it cannot be used now, and never another account: `PROFILE_NOT_FOUND` (404) for an unknown id, `INVALID_REQUEST` (400) for another provider's or another lane's account, a disabled one or an empty `profileId`, `QUOTA_EXCEEDED` (429, `details.resetAt` / `kind` and a `retry-after`) for a parked one, `AUTH_REQUIRED` (401, `details.profileId` / `title`) for one that needs sign-in. `HttpIronClient.pick(provider, { lane?, profileId? })`; `GET /iron/health` `features` adds `"pick-profile"`. In core, `pickProfile(provider, { profileId, requireUsable: true })` throws the new `ProfileParkedError` (`QUOTA_EXCEEDED`), `AuthRequiredError` or `UNSUPPORTED` instead of returning an account that cannot be used; without `requireUsable` it behaves as before.
