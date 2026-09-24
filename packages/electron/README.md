# @iron-proxy/electron

Electron glue for [Iron-Proxy](https://github.com/RealDealCPA-VR/Iron-Proxy): create the engine under `userData` with the vault key protected by `safeStorage` (DPAPI / Keychain / libsecret), expose it to the renderer as `window.ironProxy` through a whitelisted IPC bridge, and open vendor CLI logins in a real terminal window.

```ts
// main
import { app, ipcMain, safeStorage } from 'electron';
import { createElectronIronProxy, installIronProxy, openLoginTerminal } from '@iron-proxy/electron';
const iron = createElectronIronProxy({ app, safeStorage });
installIronProxy({ ipcMain, iron });
ipcMain.handle('open-login-terminal', async (_e, id: string) =>
  openLoginTerminal(await iron.loginCommand(id)),
);

// preload
import { contextBridge, ipcRenderer } from 'electron';
import { exposeIronProxy } from '@iron-proxy/electron/preload';
exposeIronProxy({ contextBridge, ipcRenderer });

// renderer
import { getIronClient } from '@iron-proxy/electron/renderer';
const client = getIronClient(); // an IronClient, e.g. for <AccountSwitcher client={client} />
```

Desktop notifications in main, with Electron's `Notification` injected so the logic runs in plain Node:

```ts
import { Notification } from 'electron';
import { createNotifier } from '@iron-proxy/electron';
const notifier = createNotifier({ iron, Notification, settings: { kinds: { login: false } } });
```

- **What shows.** `switched`: an automatic switch (`Switched to "Home Claude"` / `"Work Claude" hit its limit. Back at 3:40 PM.`, or `switched early, 96% used` for a pre-emptive switch). `parked`: an account parked with no switch after it (rate limits, sign-in expired, billing; not short `overloaded` blips). `exhausted`: `All Claude accounts are resting` / `Earliest back at 3:40 PM. Add another Claude account to keep going.` `login`: `Signed in: "…"` / `Sign-in did not finish: "…"`. The user's own switch (`activate`, reordering) shows nothing. `resumed` is a reserved kind: the manager's events do not say whether an answer was continued, so it is not produced today.
- **Coalescing.** The router announces a switch once the next account has answered, so a park is held for `coalesceMs` (2 s) and for as long as a request that started after it on another account of the same provider is running, but never longer than `maxHoldMs` (45 s) from the park, so a stream the caller abandoned cannot swallow it. The switch that follows replaces the park of the account it came from (other accounts' parks still show), and `provider.exhausted` replaces the provider's pending parks: one notification per incident. When the next account answers after `maxHoldMs` (a long stream), the park has already been shown by the time the switch arrives; the switch is then kept quiet if that account's park was shown within `throttleMs`, so the incident still makes one notification (a switch whose park was shown longer ago shows as usual).
- **Throttle.** The same kind for the same account (or provider) shows at most once per `throttleMs` (60 s). Switches are keyed on the (from, to) pair, so `a -> b` and then `c -> b` both show.
- **Settings.** `settings: { enabled?, kinds? }` at creation, `setSettings()` later. `dispose()` unsubscribes and cancels pending ones.
- **Privacy.** Text is built from profile titles and provider names only. Ids, vendor messages and login failure messages never appear, and anything shaped like an email in a title is replaced.
- **Sources.** `{ iron }` (an `IronProxy`) or `{ client }` (any `IronClient`, e.g. `HttpIronClient` for a proxy in another process). Titles are cached and refreshed from `profile.*` events. Also exported: the pure `notificationFor(event, ctx)` for hosts that show their own UI, `formatClockTime`, `safeTitle`, `NOTIFICATION_KINDS`.

The bridge carries every `IronClient` method (including `discoverLogins`, `adoptLogin` and `usageReport`); failures are rethrown in the renderer as `IronBridgeError` with `.code`, `.details` and `.hint`.

Electron is a peer dependency; the package's `.npmrc` sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` so installing it in CI never downloads the binary. Full docs in the repository's `docs/ADOPTING.md`.
