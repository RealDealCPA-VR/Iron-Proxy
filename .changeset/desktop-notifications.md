---
'@iron-proxy/electron': minor
---

Desktop notifications for any Electron host.

- **`createNotifier({ iron | client, Notification, settings?, clock?, throttleMs?, coalesceMs?, maxHoldMs?, locale?, timeZone?, providerNames?, onError? })`** subscribes to an `IronProxy` (or any `IronClient`) and shows Electron notifications through the injected `Notification` class when `Notification.isSupported()`: an automatic switch (`Switched to "Home Claude"` / `"Work Claude" hit its limit. Back at 3:40 PM.`, or `switched early, 96% used`), an account parked with no switch after it, `All Claude accounts are resting` / `Earliest back at 3:40 PM. Add another Claude account to keep going.`, and `Signed in` / `Sign-in did not finish`. The user's own switch is silent.
- A park followed by the switch it caused (within 2 s, or while the next account is still answering the same provider's request) is one notification, and only the park of the account the switch came from is replaced; a park is never held longer than `maxHoldMs` (45 s), so an abandoned stream cannot swallow it. `provider.exhausted` replaces the provider's pending parks. The same kind for the same account (for switches, the same from -> to pair) shows at most once per `throttleMs` (60 s). `setSettings({ enabled?, kinds? })` turns everything or one kind off; `dispose()` unsubscribes.
- The pure **`notificationFor(event, ctx)`** maps one `IronEvent` to `{ kind, title, body }` for hosts with their own UI. Text is built from profile titles and provider names only: no ids, emails, vendor messages or secrets, and anything shaped like an email in a title is replaced. Also exported: `formatClockTime`, `safeTitle`, `NOTIFICATION_KINDS`, `DEFAULT_PROVIDER_NAMES`.
