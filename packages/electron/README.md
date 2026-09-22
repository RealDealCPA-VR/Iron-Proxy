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

Electron is a peer dependency; the package's `.npmrc` sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` so installing it in CI never downloads the binary. Full docs in the repository's `docs/ADOPTING.md`.
