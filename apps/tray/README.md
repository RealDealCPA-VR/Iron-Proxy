# Iron-Proxy tray app (`@iron-proxy/tray`)

Iron-Proxy as a ready-made desktop app, for people who do not write code. It sits in the system tray (the menu bar on macOS), runs the local proxy for you, and lets you add, sign in, order and switch your AI accounts with a click. Every tool that can talk to the OpenAI or Anthropic API can then use your accounts through one URL, and moves to your next account of the same provider when one hits its limit.

This package is private: it is not published to npm. Installers come in the next release step. Until then you run it from a checkout (see [Run it](#run-it)).

## What it does

- **Tray menu.** One section per provider with your accounts. A radio mark shows the account that serves the next request; clicking another account makes it the one in use. Accounts that are resting say so with the local time they come back (`Work Claude Max (parked until 3:40 PM)`); accounts that need to sign in say `needs login`. With no accounts yet, the first item is **Add an account…**.
- **Tooltip.** `Iron-Proxy: Claude on "Work Claude Max"`, so a glance tells you which account is in use.
- **Base URLs.** **Copy OpenAI base URL** (`http://127.0.0.1:8791/v1`) and **Copy Anthropic base URL** (`http://127.0.0.1:8791`) for any SDK or tool.
- **Window.** **Open Iron-Proxy…** (or a click on the tray icon on Windows and Linux) opens a small window with the full account switcher: add accounts, rename, reorder, turn off, sign in with the link and code shown in the window (or in a terminal window for CLIs that insist on one), and the **Usage** panel. A header shows the proxy URL with copy buttons, and **Settings** has notifications, start at login and the proxy port. Closing the window hides it; the app keeps running in the tray until you choose **Quit Iron-Proxy**.
- **Notifications.** A desktop notification when an account switches automatically, rests, when every account of a provider is resting, and when a sign-in finishes. Each kind can be turned off, or all of them.
- **Start at login.** Off by default. One checkbox.
- **One copy at a time.** Starting the app a second time brings the running one's window forward.

## It shares its accounts with the command line

The tray uses the **same data directory as the `iron-proxy` CLI**: `~/.iron-proxy`, or the directory in `IRON_PROXY_DATA_DIR`. An account added in the tray shows up in `iron-proxy status`, and one added with `iron-proxy profiles add` or `iron-proxy setup` shows up in the tray while it runs: the tray watches `profiles.json` and `state.json` in that directory (a local file watch: nothing is polled and no quota is spent), rebuilds the menu, and reloads the window the next time you open it. Parks recorded by an `iron-proxy serve` the tray is sharing show up the same way.

The local proxy works the same way:

- The tray starts the proxy on `127.0.0.1:8791` (change the port in Settings). If that port is taken, it uses a free one and shows it.
- It writes `<dataDir>/proxy.json` in the same shape `iron-proxy serve` writes (`{ url, token, pid }`) and removes it when you quit, but only while the file still names the tray's own process.
- If `proxy.json` already names a running process (say you started `iron-proxy serve` first), the tray does not start a second server: it shows and copies that proxy's URL. A `proxy.json` left behind by a process that is gone is replaced.

The tray's own settings live next to the accounts in `<dataDir>/tray-settings.json` (switches and a port; nothing secret).

## Security, plainly

To let the CLI and the tray read the same accounts, the tray uses the CLI's file vault with the **plain key protector**, not Electron's `safeStorage`:

- **Subscription accounts store no secrets at all.** Their sign-in lives in the vendor CLI's own files inside a per-account folder; Iron-Proxy never reads or copies those tokens.
- **API keys** are encrypted (AES-256-GCM) in `vault.json`, but the master key in `vault.key` is a plain file protected by file permissions (0600 where the OS supports it), exactly as with the CLI. Anyone who can read files as your user on this computer can decrypt them. An app built on `@iron-proxy/electron`'s `createElectronIronProxy` wraps that key with the OS keychain instead, at the price of not sharing its accounts with the CLI.
- The proxy binds to loopback only. Model routes need no token there (SDKs rarely add custom headers); the control API needs the token in `proxy.json`.
- Account titles that look like an email address are masked in the menu, tooltip and notifications. No secret, email, vendor message or token ever appears in them.
- The window can ask the main process to open a terminal login only for a command that equals one of your own accounts' login commands; it cannot run anything else.

See [SECURITY.md](../../SECURITY.md) for the full picture.

## Run it

You need Node 20.11+ and pnpm. From the repository root:

```bash
pnpm install
pnpm build                                    # builds the packages the app bundles
pnpm -F @iron-proxy/tray electron-install     # once: download the Electron binary
pnpm -F @iron-proxy/tray start                # bundles the app, then runs `electron .`
```

`electron-install` runs Electron's own download step. It is needed when the install ran with `ELECTRON_SKIP_BINARY_DOWNLOAD` set (CI sets it, so the gate never needs or launches Electron). Reinstalling with the variable unset (`unset ELECTRON_SKIP_BINARY_DOWNLOAD && pnpm install --force`) does the same; `ELECTRON_SKIP_BINARY_DOWNLOAD=0` does not, because Electron skips on any non-empty value.

`pnpm -F @iron-proxy/tray build` alone bundles `out/main.cjs`, `out/preload.cjs`, `out/renderer.js` and `out/index.html` with esbuild and needs no Electron binary.

Use a separate data directory to try it without touching your real accounts:

```bash
IRON_PROXY_DATA_DIR=/tmp/iron-try pnpm -F @iron-proxy/tray start
```

## Layout

```
src/main.ts            Electron main: hands the real modules to startTrayApp
src/app.ts             the wiring (single instance, data dir, proxy, IPC, notifier, tray, window, quit)
src/electron-like.ts   the slice of the Electron API the app uses, so tests pass fakes
src/preload.ts         window.ironProxy (IronClient) + window.ironTray (proxy URL, settings, terminal, copy)
src/renderer.tsx       mounts <TrayWindow>
src/ui/TrayWindow.tsx  header, <AccountSwitcher>, settings
src/logic/menu.ts      buildTrayMenu / trayTooltip / activeAccounts: pure
src/logic/settings.ts  tray-settings.json load / save / defaults / patch
src/logic/proxy.ts     proxy.json and decideProxy(existing, isAlive): reuse or start
src/logic/shared.ts    browser-safe constants shared with the window
scripts/build.mjs      esbuild bundles
scripts/make-icons.mjs draws assets/*.png with node:zlib only (pnpm -F @iron-proxy/tray icons)
```

Tests run in plain Node with fake Electron modules (`test/fake-electron.ts`) and a real `IronProxy` on a temporary data directory: the menu for several account states, settings on disk, the proxy decision, the whole main-process wiring from start to quit, the window's React tree, and that the committed icons match the script.
