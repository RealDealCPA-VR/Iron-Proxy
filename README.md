# Iron-Proxy

### Your subscriptions. Every one of them. Never hit a wall again.

You pay for Claude Max. And ChatGPT Pro. Maybe a second Claude seat for work, a Gemini plan, a Grok subscription, a couple of API keys for the odd job. Then at 3 PM your favourite one says **"you've hit your usage limit"** and the tool you were deep inside just… stops.

Iron-Proxy makes that a non-event. Give your app a list of titled accounts per provider, let people sign in with the vendor's own tooling, and when one account maxes out the next one of the same provider takes over **mid-conversation, without anyone noticing**. When the first one's window resets, it quietly comes back. That is the whole product, and it is built to be dropped into any desktop app in an afternoon.

```
  Work Claude Max ─── "usage limit, resets 3:40 PM" ──┐
                                                       ▼  parked until 3:40
  Personal Claude ─────────────────── serving ◄────────┘
                                                       ▲  3:40 PM: primary back, automatically
  Backup API key ────────────────────── standby
```

**MIT licensed. Zero runtime dependencies in the engine. Works with the official CLIs, not against them.**

---

## Install

**The desktop tray app** (Windows, macOS, Linux), for people who do not write code: download the installer for your system from the [GitHub Releases page](https://github.com/RealDealCPA-VR/Iron-Proxy/releases) (tags `tray-v…`; the first one is not cut yet), with a `SHA256SUMS.txt` to check it against. The installers are **not code-signed** yet, so Windows SmartScreen and macOS Gatekeeper warn the first time; [apps/tray/README.md](apps/tray/README.md#install) has the exact first-launch steps.

After the first packaged release is submitted to the package managers (see [docs/RELEASING.md](docs/RELEASING.md)):

```bash
winget install RealDealCPA.IronProxy                     # Windows
brew install --cask realdealcpa-vr/tap/iron-proxy        # macOS
```

**The npm packages** (`iron-proxy` CLI, `@iron-proxy/core`, `/proxy`, `/electron`, `/react`), after the first npm publish:

```bash
npx iron-proxy setup                                     # the CLI, no install needed
npm install @iron-proxy/core                             # or /proxy, /electron, /react
```

Until that first publish, use a checkout (Node 20.11+ and pnpm):

```bash
git clone https://github.com/RealDealCPA-VR/Iron-Proxy.git && cd Iron-Proxy
pnpm install && pnpm build
node packages/cli/dist/cli.js setup                      # the CLI
pnpm -F @iron-proxy/tray start                           # the tray app (after `pnpm -F @iron-proxy/tray electron-install`)
```

To use a package in your own app before then, pack it and its `@iron-proxy/*` dependencies from the checkout and install the tarballs together:

```bash
(cd packages/core && pnpm pack --pack-destination /tmp/iron) && (cd packages/proxy && pnpm pack --pack-destination /tmp/iron)
npm install /tmp/iron/iron-proxy-core-0.1.0.tgz /tmp/iron/iron-proxy-proxy-0.1.0.tgz
```

## For everyone: the tray app

Not a developer? [`apps/tray`](apps/tray) is Iron-Proxy as a small desktop app. It lives in the system tray (the menu bar on macOS) and shows each provider's accounts with a mark on the one in use; click another to switch. It tells you when an account is resting and when it comes back (`Work Claude Max (parked until 3:40 PM)`), sends a desktop notification when it switches for you, and copies the two base URLs (`http://127.0.0.1:8791/v1` for OpenAI-style tools, `http://127.0.0.1:8791` for Anthropic-style ones) so any tool can use your accounts. Its window is the full account switcher: add accounts, sign in, reorder, see usage.

It shares its accounts with the `iron-proxy` command line (the same `~/.iron-proxy` folder), so you can mix the two freely.

Installers for Windows (x64, ARM), macOS (Intel, Apple silicon) and Linux (AppImage, deb) are built by the tray release workflow and attached to a GitHub Release for each `tray-v…` tag. To be honest about where it stands: they are not code-signed yet, and no release has been cut so far; until one is, run it from a checkout with `pnpm -F @iron-proxy/tray start` (see [apps/tray/README.md](apps/tray/README.md)).

## Why people want this

- **Stop rationing.** Two accounts of a provider are two windows. Three are three. Iron-Proxy uses the one that is ready and remembers when the others come back.
- **Bring your own subscription, honestly.** The subscription lane drives the vendor's _official_ CLI (`claude`, `codex`, `grok`, `gemini`), each account in its own isolated home directory. Sign-in is the vendor's sign-in. No scraped tokens, no home-brewed OAuth against a consumer plan, nothing for a vendor to object to.
- **Any app, any language.** Use it as a TypeScript library, or run the local proxy and point the OpenAI SDK or the Anthropic SDK at `http://127.0.0.1:8791`. Python, Rust, Go, a shell script: if it can speak OpenAI or Anthropic wire format, it gets account switching for free.
- **A finished switcher UI, not a TODO.** `<AccountSwitcher />` ships styled, accessible, light and dark: add, title, reorder, toggle, log in with the link and code right in the panel, watch usage bars and parked countdowns. Ten lines in an Electron app.
- **Switch before the wall, finish the sentence.** An API-key account whose rate-limit window is 95% used (read from the provider's rate-limit headers) is tried last until it resets, so requests move on before they fail. Subscription (CLI) accounts report no usage window, so they switch when the vendor CLI says the limit is hit. Opt in to `resumeInterrupted` (`x-iron-resume: 1`, `chat --resume`) and an answer cut off by a limit mid-stream is continued by your next account of that provider.
- **Know how long you have.** Iron-Proxy keeps a small local history (counts and times only, never prompts or output): requests and tokens per account for the last 5 hours, 24 hours and 7 days, parks this week, and, once a few usage readings show the trend (API-key accounts, from rate-limit headers), "about 40 min left at this pace". `iron-proxy usage`, `IronProxy.usageReport()`, `GET /iron/usage`, or the **Usage** button in the switcher.
- **Your data stays with the provider you chose.** Failover is same-provider only. A Claude request never lands at OpenAI because a limit was hit. When every account of a provider is parked, your app is told, with the earliest reset time, and _you_ decide.
- **Secrets done properly.** API keys live in an AES-256-GCM vault whose master key is wrapped by the OS keychain in Electron (DPAPI, Keychain, libsecret). No passphrase prompts. Click and continue.

## Pick your integration

| You have…                                                       | Use                                                                                 | Effort                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| An Electron + React app                                         | [`@iron-proxy/electron`](packages/electron) + [`@iron-proxy/react`](packages/react) | ~10 lines. Main, preload, one component.     |
| A Node app of any kind                                          | [`@iron-proxy/core`](packages/core)                                                 | `createIronProxy()` then `iron.stream(...)`. |
| An app in another language, or an SDK you do not want to change | [`@iron-proxy/proxy`](packages/proxy) / `npx iron-proxy serve`                      | Change one base URL.                         |
| A terminal and five minutes                                     | [`iron-proxy`](packages/cli)                                                        | `doctor`, `profiles add`, `login`, `chat`.   |

Step-by-step for each: [docs/ADOPTING.md](docs/ADOPTING.md).

## Sixty seconds

`npx iron-proxy` works after the first npm publish; until then run `node packages/cli/dist/cli.js` from a checkout in its place (see [Install](#install)).

```bash
npx iron-proxy setup                                               # guided: checks the CLIs, adopts logins, adds accounts
```

Or step by step:

```bash
npx iron-proxy doctor                                              # which vendor CLIs are installed
npx iron-proxy profiles add --provider anthropic --lane cli --title "Work Claude Max"
npx iron-proxy login <id>                                          # prints the sign-in link and code
npx iron-proxy profiles add --provider anthropic --lane cli --title "Personal Claude"
npx iron-proxy login <id>
npx iron-proxy chat anthropic "Hello from two accounts"            # streams; says which one served
npx iron-proxy serve --port 8791                                   # now every SDK can use them
```

Already signed in to Claude Code, Codex or Grok on this computer? Skip the second login:

```bash
npx iron-proxy profiles discover                                   # existing CLI logins, signed in or not
npx iron-proxy profiles adopt anthropic                            # use ~/.claude as-is, as an account
```

An adopted login stays exactly where it is: nothing is copied, Iron-Proxy never deletes that directory, and the switcher shows it under **Found on this computer** with a one-click **Use this account**. When something does go wrong, every error carries a one-line `hint` saying what to do next (the CLI prints it, the proxy returns it, the switcher shows it).

## Use your accounts in your own terminal

The same accounts work when you type `claude`, `codex`, `grok` or `gemini` yourself:

```bash
npx iron-proxy run anthropic                     # starts Claude Code as the account that is ready right now
npx iron-proxy run openai -- --model gpt-5       # anything after -- goes to the vendor CLI
eval "$(npx iron-proxy env anthropic --shell bash)"  # bash/zsh (Git Bash too): this shell now runs claude as that account
npx iron-proxy env anthropic | Out-String | Invoke-Expression  # PowerShell (--shell cmd prints set "..." lines)
```

`run` picks the account a request would use first (enabled, not parked, signed in, lowest order), prints `Using "<title>" (<provider>)` (with `--profile id` it uses that account even when it is parked or signed out, and prints a `Note:` line saying so), and starts the vendor CLI with its home variable set and every `*_API_KEY` removed, so the subscription pays, not a stray key. On Windows `env` prints PowerShell lines unless you pass `--shell bash` or `--shell cmd`. `env` prints only the home variable (plus the profile's own `cli.env` entries) and lines that clear the API-key variables; never `PATH`, never a secret.

`npx iron-proxy usage` shows each account's requests and tokens for 5h / 24h / 7d, its parks this week and, when there is enough of a trend, `about N min left at this pace` (`(rough)` while it rests on few readings). It reads the local history only and never calls a provider.

An interactive session **cannot switch accounts mid-session**: it stays on the account it started with. When that account hits its limit, quit and `iron-proxy run` again; the next ready account takes over.

Or in code:

```ts
import { createIronProxy } from '@iron-proxy/core';

const iron = createIronProxy();
for await (const ev of iron.stream({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
})) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
  if (ev.type === 'switched')
    console.error(`\n[${ev.fromProfileId} → ${ev.toProfileId}: ${ev.reason.kind}]`);
}
```

## How the failover actually works

1. Accounts of a provider are **ordered**. The lowest order serves. "Use this" in the UI moves an account to the front.
2. A **quota signal** parks an account: HTTP 429 / 402 / 401 / 529 with the provider's own reset headers, or the CLI printing "you've hit your usage limit… resets at 3pm". The park lasts exactly as long as the provider says, or a sensible default when it does not.
3. The **next ready account of the same provider** takes the request. Before any content has streamed the switch is invisible; mid-stream it surfaces as a retryable `STREAM_INTERRUPTED` so nobody gets two half-answers glued together.
4. When the primary's park expires it **serves again on its own**. No timers, no background polling, no quota spent checking.
5. **Never across providers.** All accounts parked means `ALL_PROFILES_EXHAUSTED` with the earliest reset, and a `provider.exhausted` event for your UI.

The full contract, with cooldown tables: [docs/FAILOVER.md](docs/FAILOVER.md).

## Three ways an account can sign in

| Lane             | What it is                                                                                                                                                                                                                                                 | Best for                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Subscription** | An isolated home for the vendor's official CLI, set through the CLI's own variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `GEMINI_CLI_HOME`). Requests run through the CLI headlessly. Iron-Proxy never reads a token out of the vendor's files. | Claude Max/Pro/Team, ChatGPT Plus/Pro, Grok, Gemini plans.                                      |
| **API key**      | A key in the encrypted vault, direct HTTPS, full streaming, tools and images.                                                                                                                                                                              | Pay-as-you-go, OpenRouter, Groq, Together, Ollama, LM Studio, vLLM, anything OpenAI-compatible. |
| **OAuth**        | An interface. Register your own sanctioned flow and its profiles route like any other.                                                                                                                                                                     | Enterprise IdPs, vendor partnerships.                                                           |

## Providers

| Provider                   | Subscription lane       | API-key lane      |
| -------------------------- | ----------------------- | ----------------- |
| Anthropic                  | Claude Code (`claude`)  | Messages API      |
| OpenAI                     | Codex CLI (`codex`)     | Chat Completions  |
| Google                     | Gemini CLI (`gemini`)   | Gemini API        |
| xAI                        | Grok Build CLI (`grok`) | OpenAI-compatible |
| Anything OpenAI-compatible | —                       | base URL + key    |

Wire-format translation is built in: a request in OpenAI shape can be served by an Anthropic account and back, including tools, tool results and images. What has been verified live versus against fixtures, per provider: [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Built to be read

- **One data model, one router, adapters that are mostly data.** A new CLI is about sixty lines. A new OpenAI-compatible endpoint is a base URL.
- **Everything is an event.** Every park, switch, login step and request goes to the same stream your UI, the proxy's SSE feed and your logs read.
- **Tests drive the real thing.** Failover tests run the real router; CLI tests spawn a fake vendor CLI through the exact code path the real ones use. 150 tests, green on Ubuntu, Windows and macOS on Node 20 and 22.
- **No marketplace, no plugin loader, no telemetry, no native modules.**

Map of the whole thing: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository

```
packages/core      engine (zero deps)          packages/electron  main + preload + keychain protector + notifications
packages/proxy     local HTTP server + client  packages/react     hook + styled AccountSwitcher
packages/cli       `iron-proxy` binary         examples/electron-host  minimal wired app
apps/tray          the desktop tray app (private, not on npm)
docs/              architecture, adopting, providers, failover, roadmap
```

[Roadmap](docs/ROADMAP.md) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Status

Pre-1.0 and honest about it. The engine, translators, vault, router and CLI lane are tested against a fake vendor CLI and fake HTTP providers on three operating systems. Live runs against real subscriptions are being recorded per provider in [docs/PROVIDERS.md](docs/PROVIDERS.md); the Gemini CLI spec follows its public docs and has not yet been run for real. If you have an account to spare, a live result is the most useful pull request you can send.

## License

[MIT](LICENSE) © RealDealCPA
