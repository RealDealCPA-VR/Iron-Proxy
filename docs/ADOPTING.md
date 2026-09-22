# Adopting Iron-Proxy

Three integration shapes, from most to least code. All three share the same data on disk, so you can start with the proxy and move to the library later without migrating anything.

## 1. Electron app with the React switcher (recommended)

```bash
pnpm add @iron-proxy/core @iron-proxy/electron @iron-proxy/react
```

**main.ts**

```ts
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import { createElectronIronProxy, installIronProxy, openLoginTerminal } from '@iron-proxy/electron';

const iron = createElectronIronProxy({ app, safeStorage }); // dataDir = <userData>/iron-proxy, vault key under the OS keychain
const bridge = installIronProxy({ ipcMain, iron }); // window.ironProxy <-> LocalIronClient

// Optional: let the UI open the vendor CLI login in a real terminal window.
ipcMain.handle('open-login-terminal', async (_e, profileId: string) => {
  openLoginTerminal(await iron.loginCommand(profileId));
});

// Run requests wherever you already call a model:
ipcMain.handle('chat', async (_e, prompt: string) => {
  const res = await iron.complete({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  });
  return res.message.content;
});

app.on('before-quit', () => void iron.close());
```

**preload.ts**

```ts
import { contextBridge, ipcRenderer } from 'electron';
import { exposeIronProxy } from '@iron-proxy/electron/preload';
exposeIronProxy({ contextBridge, ipcRenderer });
```

**renderer**

```tsx
import { AccountSwitcher } from '@iron-proxy/react';
import { getIronClient } from '@iron-proxy/electron/renderer';

export function Settings() {
  return (
    <AccountSwitcher
      client={getIronClient()}
      onOpenTerminal={(cmd) => window.electron.invoke('open-login-terminal', cmd.profileId)}
    />
  );
}
```

That is the whole integration. Users add accounts, title them, order them, sign in through the vendor's own flow, and your `iron.complete` / `iron.stream` calls fail over between them.

## 2. Any app, via the local proxy

```bash
npx iron-proxy serve --port 8791
# → http://127.0.0.1:8791  token: 6f1c…   (also written to ~/.iron-proxy/proxy.json)
```

Point your SDK at it:

```ts
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://127.0.0.1:8791/v1', apiKey: 'unused' });
await client.chat.completions.create({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'Hi' }],
  stream: true,
});
```

```ts
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ baseURL: 'http://127.0.0.1:8791', apiKey: 'unused' });
```

Headers you may add:

| Header                          | Effect                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `x-iron-provider: anthropic`    | Force a provider when the model name is not recognisable.           |
| `x-iron-profile: <id>`          | Start on this account (failover still applies within its provider). |
| `authorization: Bearer <token>` | Required on `/iron/*` control routes.                               |

Manage accounts from the terminal (`iron-proxy profiles add …`, `iron-proxy login <id>`), from the control API (`/iron/profiles`, `/iron/events`), or embed the React switcher with the HTTP client:

```tsx
import { HttpIronClient } from '@iron-proxy/proxy/client';
<AccountSwitcher client={new HttpIronClient('http://127.0.0.1:8791', token)} />;
```

Spawn the proxy as a child process from your app if you do not want a separate daemon; `proxy.json` tells you where it is listening.

## 3. Node library only

```ts
import { createIronProxy } from '@iron-proxy/core';
const iron = createIronProxy({ dataDir });
```

Everything the UI does is a method on `iron` (`createProfile`, `login`, `activate`, `reorder`, `refreshStatus`, …) and everything that happens is an event on `iron.events`. `LocalIronClient` wraps it in the same `IronClient` shape the React package expects, so you can render the switcher in any React app that can call Node.

## Choosing a dataDir

- Per-app isolation: your own directory (Electron: `<userData>/iron-proxy`).
- Shared accounts across your tools: `~/.iron-proxy` (the default) or `IRON_PROXY_DATA_DIR`.

## Handling "everything is parked"

```ts
import { AllProfilesExhaustedError } from '@iron-proxy/core';
try {
  await iron.complete(req);
} catch (err) {
  if (err instanceof AllProfilesExhaustedError) {
    // err.provider, err.earliestResetAt → show "All Claude accounts are resting until 3:40 PM.
    // Add another Claude account or switch to Gemini?" — that is the user's choice, not the router's.
  }
}
```

## Streaming and mid-stream limits

A limit that arrives before the first token is invisible to you (you see a `switched` event). A limit that arrives after tokens were streamed ends the stream with `{ type: 'error', error: { code: 'STREAM_INTERRUPTED', retryable: true } }`; resend the same request and the parked account is skipped.

## Testing your integration

- Inject `fetch` into `createIronProxy({ fetch })` to fake provider responses. A `429` with `anthropic-ratelimit-requests-reset` is enough to exercise failover.
- Point a CLI profile at `packages/core/test/fixtures/fake-cli/fake-cli.mjs` (set `cli.binary` to the script path and `cli.env.FAKE_CLI_FLAVOR`) to exercise login and quota handling without a real account.
- Use `MemoryProfileStore`, `MemoryStateStore`, `MemoryVault` to keep tests hermetic.
