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

## Why people want this

- **Stop rationing.** Two accounts of a provider are two windows. Three are three. Iron-Proxy uses the one that is ready and remembers when the others come back.
- **Bring your own subscription, honestly.** The subscription lane drives the vendor's _official_ CLI (`claude`, `codex`, `grok`, `gemini`), each account in its own isolated home directory. Sign-in is the vendor's sign-in. No scraped tokens, no home-brewed OAuth against a consumer plan, nothing for a vendor to object to.
- **Any app, any language.** Use it as a TypeScript library, or run the local proxy and point the OpenAI SDK or the Anthropic SDK at `http://127.0.0.1:8791`. Python, Rust, Go, a shell script: if it can speak OpenAI or Anthropic wire format, it gets account switching for free.
- **A finished switcher UI, not a TODO.** `<AccountSwitcher />` ships styled, accessible, light and dark: add, title, reorder, toggle, log in with the link and code right in the panel, watch usage bars and parked countdowns. Ten lines in an Electron app.
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

```bash
npx iron-proxy doctor                                              # which vendor CLIs are installed
npx iron-proxy profiles add --provider anthropic --lane cli --title "Work Claude Max"
npx iron-proxy login <id>                                          # prints the sign-in link and code
npx iron-proxy profiles add --provider anthropic --lane cli --title "Personal Claude"
npx iron-proxy login <id>
npx iron-proxy chat anthropic "Hello from two accounts"            # streams; says which one served
npx iron-proxy serve --port 8791                                   # now every SDK can use them
```

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
packages/core      engine (zero deps)          packages/electron  main + preload + keychain protector
packages/proxy     local HTTP server + client  packages/react     hook + styled AccountSwitcher
packages/cli       `iron-proxy` binary         examples/electron-host  minimal wired app
docs/              architecture, adopting, providers, failover, roadmap
```

[Roadmap](docs/ROADMAP.md) · [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Status

Pre-1.0 and honest about it. The engine, translators, vault, router and CLI lane are tested against a fake vendor CLI and fake HTTP providers on three operating systems. Live runs against real subscriptions are being recorded per provider in [docs/PROVIDERS.md](docs/PROVIDERS.md); the Gemini CLI spec follows its public docs and has not yet been run for real. If you have an account to spare, a live result is the most useful pull request you can send.

## License

[MIT](LICENSE) © RealDealCPA
