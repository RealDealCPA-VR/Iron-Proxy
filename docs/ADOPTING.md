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

**Optional: desktop notifications** (in main.ts, after `createElectronIronProxy`)

```ts
import { Notification } from 'electron';
import { createNotifier } from '@iron-proxy/electron';
const notifier = createNotifier({ iron, Notification }); // notifier.setSettings({ kinds: { login: false } }) / notifier.dispose()
```

The user hears about an automatic switch (`Switched to "Home Claude"` / `"Work Claude" hit its limit. Back at 3:40 PM.`), an account parked with no other account to take over, every account of a provider resting, and a sign-in that finished or failed. A park followed by its switch is one notification (a park is held at most `maxHoldMs`, 45 s, waiting for it); the same notification for the same account shows at most once a minute (`throttleMs`); the user's own switch is silent. The text holds titles and provider names only, never emails, ids or vendor messages. `setSettings({ enabled: false })` turns it off; `kinds: { switched, parked, exhausted, login }` turn off one kind.

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
| `x-iron-resume: 1`              | Continue a stream cut off by a limit on the next account (opt-in).  |
| `authorization: Bearer <token>` | Required on `/iron/*` control routes.                               |

Manage accounts from the terminal (`iron-proxy profiles add …`, `iron-proxy login <id>`), from the control API (`/iron/profiles`, `/iron/events`), or embed the React switcher with the HTTP client:

```tsx
import { HttpIronClient } from '@iron-proxy/proxy/client';
<AccountSwitcher client={new HttpIronClient('http://127.0.0.1:8791', token)} />;
```

Spawn the proxy as a child process from your app if you do not want a separate daemon; `proxy.json` tells you where it is listening. To ship it inside your app, `pnpm --filter iron-proxy bundle` (from a clone of this repository) writes the whole CLI as one dependency-free ESM file, `packages/cli/dist-bundle/iron-proxy.mjs`; run it with your own Node (`node iron-proxy.mjs serve --port 0 --data-dir <dir>`) or, in an Electron app, with Electron itself as Node (`ELECTRON_RUN_AS_NODE=1 <electron exe> iron-proxy.mjs serve …`). `--port 0` picks a free port and `serve` creates the data directory when it is missing; `iron-proxy.mjs --version` prints the version it was built from.

## 3. Node library only

```ts
import { createIronProxy } from '@iron-proxy/core';
const iron = createIronProxy({ dataDir });
```

Everything the UI does is a method on `iron` (`createProfile`, `login`, `activate`, `reorder`, `refreshStatus`, …) and everything that happens is an event on `iron.events`. `LocalIronClient` wraps it in the same `IronClient` shape the React package expects, so you can render the switcher in any React app that can call Node.

## Choosing a dataDir

- Per-app isolation: your own directory (Electron: `<userData>/iron-proxy`).
- Shared accounts across your tools: `~/.iron-proxy` (the default) or `IRON_PROXY_DATA_DIR`. The `iron-proxy` CLI and the tray app (`apps/tray`) both use it, and several processes on one directory see each other's changes and can write at the same time without losing any (writes merge under a short-lived lock file).
- Just want account switching for the tools you already use, without writing code? That is the tray app: see [apps/tray/README.md](../apps/tray/README.md).

## Using a login the user already has

Most people who want account switching already have a vendor CLI signed in at its default location (`~/.claude`, `~/.codex`, `~/.grok`, or wherever `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME` point). They can turn that into a profile in one click, with no second login:

```ts
const found = await iron.discoverLogins();
// [{ provider: 'anthropic', binary: 'claude', home: 'C:\\Users\\me\\.claude', installed: true,
//    status: 'ok', suggestedTitle: 'Claude (existing login)' }, …]
const ok = found.filter((f) => f.status === 'ok' && !f.adoptedProfileId);
const profile = await iron.adoptLogin({ provider: ok[0].provider, home: ok[0].home });
```

- `discoverLogins()` runs each CLI's own status command against its default home (all of them at once; results keep a fixed provider order). `iron-proxy profiles adopt <provider>` without `--home` looks only at that provider's default home and runs no other CLI. It never reads the vendor's credential files, never persists anything, and never reports an email. `adoptedProfileId` is set when a profile already uses that home.
- `adoptLogin()` creates a subscription profile whose `cli.home` is that exact directory and marks it `cli.adopted: true`. It then checks that one profile's sign-in once, with its own CLI's status command, and stores the result (read it with `allStates()`). It refuses (`INVALID_REQUEST`) when the directory does not exist or another profile already uses it.
- Deleting an adopted profile **never** removes the directory; Iron-Proxy only deletes a home that is not adopted and lies strictly inside `<dataDir>/cli-homes` (not that folder itself, not a sibling such as `cli-homes-old`). It also never prepares or recreates an adopted home. `updateProfile` (and `PATCH /iron/profiles/:id`) ignores `cli.adopted` in a patch, and ignores `cli.home` for an adopted profile, so no patch can turn an adopted login into one Iron-Proxy would delete.
- **Logging out an adopted profile signs the user's own CLI out too**, because it is the same login. The React switcher asks for confirmation first, and `iron-proxy logout` prints a note.
- Gemini is not offered: where the Gemini CLI keeps its sign-in by default is unverified (see [PROVIDERS.md](PROVIDERS.md#existing-logins)).
- Tests and unusual setups can pass `createIronProxy({ env })` so discovery reads a different `HOME` / `USERPROFILE` / home variables than `process.env`.

The same two calls exist on every transport: `IronClient.discoverLogins()` / `adoptLogin(input)`, the proxy's `GET /iron/discover` and `POST /iron/adopt` (`{ provider, home, title? }`), the Electron bridge, and `iron-proxy profiles discover` / `profiles adopt <provider> [--home DIR] [--title T]`. In the switcher, **Add account** lists them under **Found on this computer**.

## First run, and the user's own terminal

`iron-proxy setup` is the guided first run: it shows which vendor CLIs are installed (with the official install command for each missing one), offers every signed-in login found on the computer (`Use "Claude (existing login)" as an account? [Y/n]`), then loops on `Add another account? [y/N]` (provider, lane, title, then the headless sign-in with its URL and code, or the API key read without echo). `iron-proxy setup --yes` adopts every signed-in login without asking and prints the summary, for scripts.

To use an account from the user's own terminal:

- `iron-proxy run <provider> [--profile id] [-- args]` starts the vendor CLI interactively as `iron.pickProfile(provider)`: the account the router would try first right now (enabled, cli lane, not parked, expired parks cleared exactly as a request clears them, not signed out, lowest order). The environment is the lane's own scrubbed one (`iron.interactiveCommand(id, args)`: home variable set, `*_API_KEY` removed), the child's exit code is passed through, and on Windows a `.cmd` shim runs through `cmd.exe /d /s /c` with every argument escaped.
- `iron-proxy env <provider> [--profile id] [--shell bash|powershell|cmd]` prints the lines to paste or eval (`iron.shellEnv(id)`; the default is PowerShell on Windows and bash elsewhere, so use `eval "$(iron-proxy env anthropic --shell bash)"` in Git Bash): the home variable and the profile's `cli.env` entries, plus lines clearing the API-key variables for bash and PowerShell. Never `PATH`, never a secret.
- `pickProfile` throws `NO_PROFILE`, `ALL_PROFILES_EXHAUSTED` (with the earliest reset) or `AUTH_REQUIRED`, each with its hint; with `profileId` it returns that account (even when parked or signed out; `run` and `env` then print a `Note:` line on stderr saying so) or `INVALID_REQUEST` when it is not a cli account of that provider.
- **An interactive session cannot switch accounts mid-session.** Failover happens between requests Iron-Proxy runs; a vendor CLI you are typing into stays on the account it started with. When it hits the limit, quit and `iron-proxy run` again: the next ready account is picked.

## Running the vendor CLI yourself (the external-executor API)

Some hosts already drive the vendor CLI themselves (their own streaming, tools and images) and want Iron-Proxy only as the **account manager**: which accounts exist, their order, who is parked until when, sign-in and usage. They ask Iron-Proxy which account to use, run the CLI as that account, and report what happened. Same provider only: Iron-Proxy never answers with another provider's account.

1. **Pick.** `GET /iron/pick?provider=anthropic[&lane=cli]` (`lane` is `cli` by default; also `api-key`, `oauth`, `any`) answers `200 { "profile": Profile, "env": { "set": { "CLAUDE_CONFIG_DIR": "<abs path>" }, "unset": ["ANTHROPIC_API_KEY", …] } }`: the account a request would use right now (`iron.pickProfile`, expired parks cleared exactly as a request clears them) and the variables that run its vendor CLI as that account (`iron.shellEnv`: the home variable and the profile's `cli.env`; `unset` lists the API-key variables to remove from the child's environment so a stray key cannot bypass the subscription). `env` is `null` when the pick is not a cli account.
2. **Run** the vendor CLI with that environment.
3. **Report a failure:** `POST /iron/profiles/:id/signal` with `{ "status"?: number, "headers"?: { "<lowercase name>": "value" }, "text"?: string }`. Iron-Proxy classifies it with its own detectors (`detectFromHttp` when `status` is given, otherwise `detectFromCliOutput` on `text`) and, on a quota signal, parks the account through the router's own park path (the same `profile.parked` event, usage park record and state as an internal park; `auth-expired` leaves it `unauthenticated`, which is "needs sign-in"). Answers `{ "parked": true, "signal": { "kind", "resetAt"?, "message"?, … }, "state": ProfileState }` or `{ "parked": false }` (a model-access 403 or any error that is not about the account). Hand over the raw status, the `retry-after` / `anthropic-ratelimit-*` / `x-ratelimit-*` headers and the body or CLI text; let Iron-Proxy decide. Then pick again: the next account of the same provider comes back, or one of the errors below.
4. **Report a success:** `POST /iron/profiles/:id/finished` with `{ "usage"?: { "inputTokens": int, "outputTokens": int, "cacheReadTokens"?: int }, "durationMs"?: int, "model"?: string }`. Recorded exactly like a request Iron-Proxy ran: the account becomes its provider's `active`, `served` increments, `request.finished` is emitted (with `model` when given) and a usage record is appended. Answers `{ "ok": true, "state": ProfileState }`.

All three need the bearer token. In Node the same calls are `iron.pickProfile()` + `iron.shellEnv()`, `iron.reportSignal(id, input)` and `iron.reportFinished(id, input)`; over HTTP from TypeScript, `HttpIronClient.pick(provider, { lane? })`, `.signal(id, input)` and `.finished(id, input)`. They are deliberately **not** part of the `IronClient` interface (the switcher, the Electron bridge and the React package do not use them).

**Errors.** Every `/iron/*` error is `status` + `{ "error": { "message", "code" }, "iron": { "code", "retryable", "details", "hint"? } }`. Read `iron.code`; `iron.hint` is one sentence for the user.

| `iron.code`              | Status | When                                                       | `iron.details`                                                         |
| ------------------------ | ------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `NO_PROFILE`             | 404    | no enabled account of that provider on that lane           | `{ provider }`                                                         |
| `ALL_PROFILES_EXHAUSTED` | 429    | every such account is parked (also a `retry-after`)        | `{ provider, resetAt?, earliestResetAt?, tried }` (`resetAt` = ISO)    |
| `AUTH_REQUIRED`          | 401    | the rest need sign-in (`profileId` / `title` of the first) | `{ profileId, title? }`                                                |
| `AUTH_REQUIRED`          | 401    | the bearer token is missing or wrong                       | `{}` (no `profileId`: tell this apart from an account needing sign-in) |
| `INVALID_REQUEST`        | 400    | missing/unknown provider or lane, a bad body               | varies                                                                 |
| `PROFILE_NOT_FOUND`      | 404    | `:id` does not exist                                       | `{ profileId }`                                                        |

A parked account is skipped by the next pick until its reset; a signed-out one until it signs in again (`POST /iron/profiles/:id/login`, or the login command from `GET /iron/profiles/:id/login-command` run in a terminal).

## Every error says what to do next

Every `IronProxyError` carries a `hint`: one short imperative sentence for the user, never containing a secret or an email. Examples:

| Code                     | Hint (shape)                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `NO_PROFILE`             | Add an account for anthropic: `iron-proxy profiles add --provider anthropic …`, or 'Add account' in the switcher. |
| `AUTH_REQUIRED`          | Log "Work Claude" in again: `iron-proxy login <id>`, or 'Log in' on it in the switcher.                           |
| `ALL_PROFILES_EXHAUSTED` | Wait until 3:40:00 PM for the first reset, or add another anthropic account: …                                    |
| `CLI_NOT_FOUND`          | Install Claude Code: `npm install -g @anthropic-ai/claude-code` (the official command per CLI).                   |
| `STREAM_INTERRUPTED`     | Resend; the next account will take it.                                                                            |

Where it surfaces: `err.hint` in Node; `error.hint` in serialized errors and stream `error` events; the `iron.hint` field of every proxy error body; `.hint` on `HttpIronClientError` and on the Electron preload's `IronBridgeError`; a `hint: …` line after the error in the CLI; and under the message in the React `ErrorBanner` (`ClientError.hint`). `DEFAULT_HINTS` has one per code; raisers pass a more specific one where they know more.

## Handling "everything is parked"

```ts
import { AllProfilesExhaustedError } from '@iron-proxy/core';
try {
  await iron.complete(req);
} catch (err) {
  if (err instanceof AllProfilesExhaustedError) {
    // err.provider, err.earliestResetAt → show "All Claude accounts are resting until 3:40 PM.
    // Add another Claude account or switch to Gemini?" — that is the user's choice, not the router's.
    // err.hint already says the first half in one line.
  }
}
```

## Streaming and mid-stream limits

A limit that arrives before the first token is invisible to you (you see a `switched` event). A limit that arrives after tokens were streamed ends the stream with `{ type: 'error', error: { code: 'STREAM_INTERRUPTED', retryable: true } }`; resend the same request and the parked account is skipped.

## Testing your integration

- Inject `fetch` into `createIronProxy({ fetch })` to fake provider responses. A `429` with `anthropic-ratelimit-requests-reset` is enough to exercise failover.
- Point a CLI profile at `packages/core/test/fixtures/fake-cli/fake-cli.mjs` (set `cli.binary` to the script path and `cli.env.FAKE_CLI_FLAVOR`) to exercise login and quota handling without a real account.
- Use `MemoryProfileStore`, `MemoryStateStore`, `MemoryVault` to keep tests hermetic.
