# Iron-Proxy

**Bring-your-own-subscription account switching for AI providers.**

Give your desktop app a list of titled accounts per provider ("Work Claude Max", "Personal ChatGPT Plus", "Team Gemini"), let people sign in with the vendor's own tooling, and stop caring about usage limits: when one account maxes out, the next one of the same provider takes over, and the first one comes back on its own when its window resets.

Iron-Proxy is a backend building block, not an app. It ships as:

| Package                                     | What it is                                                                                                                                   | Use it when                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`@iron-proxy/core`](packages/core)         | The engine: profiles, encrypted vault, adapters, ordered failover router, events. Zero runtime dependencies.                                 | You run Node (Electron main, a daemon, a CLI).                                   |
| [`@iron-proxy/proxy`](packages/proxy)       | A localhost server exposing **OpenAI-compatible** and **Anthropic-compatible** endpoints plus a small control API, and an HTTP `IronClient`. | Your app or another language's SDK should just point at `http://127.0.0.1:PORT`. |
| [`@iron-proxy/electron`](packages/electron) | Main-process install, preload bridge (`window.ironProxy`), OS-keychain key protection via `safeStorage`, "open login in a terminal" helper.  | You are building an Electron app.                                                |
| [`@iron-proxy/react`](packages/react)       | `useIronProxy()` and a styled, accessible `<AccountSwitcher />`: add, title, reorder, toggle, log in, watch usage and parked timers.         | You want a working switcher in ten lines.                                        |
| [`iron-proxy`](packages/cli)                | Command line: run the proxy, manage profiles, log in, chat.                                                                                  | Scripts, testing, non-Electron hosts.                                            |

## How accounts sign in

Every account is a **profile** in one of three lanes:

- **Subscription (CLI lane).** The profile owns an isolated home directory for the vendor's official CLI (`claude`, `codex`, `grok`, `gemini`), set through that CLI's own environment variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `GEMINI_CLI_HOME`). Login is the vendor's login. Requests run through the CLI in headless mode. Iron-Proxy never reads a token out of the vendor's files and never mints its own OAuth session against a consumer subscription, which keeps you inside the vendors' terms.
- **API key.** A key stored in an AES-256-GCM vault whose master key is protected by the OS keychain in Electron. Pay-as-you-go, direct HTTPS, full streaming and tool-call support.
- **OAuth (extension point).** An interface, not an implementation. If you have a sanctioned OAuth flow, register a lane and profiles of that lane route like any other.

## How failover works

1. Accounts of a provider are ordered. The lowest order serves.
2. A quota signal (HTTP 429 / 402 / 401 / 529, provider reset headers, or the CLI printing "you've hit your usage limit… resets at 3pm") **parks** that account until the provider says it resets, or a sensible default.
3. The next ready account of the **same provider** takes the request. Before any content has streamed, this is invisible to the caller; mid-stream it surfaces as a retryable `STREAM_INTERRUPTED`.
4. When the primary's park expires it serves again automatically.
5. Iron-Proxy **never switches providers by itself.** When every account of a provider is parked you get `ALL_PROFILES_EXHAUSTED` with the earliest reset time, and your app decides.

Details: [docs/FAILOVER.md](docs/FAILOVER.md).

## Quick start

```bash
pnpm add @iron-proxy/core
```

```ts
import { createIronProxy } from '@iron-proxy/core';

const iron = createIronProxy({ dataDir: '/path/for/this/app' });

// Two Claude accounts: a subscription and a pay-as-you-go key.
const work = await iron.createProfile({
  title: 'Work Claude Max',
  provider: 'anthropic',
  lane: 'cli',
});
const session = await iron.login(work.id); // prints a URL / opens the browser through the official CLI
session.on((e) => e.type === 'url' && console.log('Sign in at', e.url));
await session.done;

await iron.createProfile({
  title: 'Backup key',
  provider: 'anthropic',
  lane: 'api-key',
  apiKeySecret: process.env.ANTHROPIC_API_KEY!,
});

// Just ask. The router picks the account.
for await (const ev of iron.stream({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
})) {
  if (ev.type === 'text') process.stdout.write(ev.delta);
  if (ev.type === 'switched')
    console.error(`\n[switched ${ev.fromProfileId} -> ${ev.toProfileId}: ${ev.reason.kind}]`);
}
```

Or run the proxy and point any SDK at it:

```bash
npx iron-proxy serve --port 8791
# OpenAI SDK:    baseURL http://127.0.0.1:8791/v1
# Anthropic SDK: baseURL http://127.0.0.1:8791
```

Electron + React in ten lines: [docs/ADOPTING.md](docs/ADOPTING.md).

## Providers in v1

| Provider                   | Subscription lane (official CLI) | API-key lane                                                  |
| -------------------------- | -------------------------------- | ------------------------------------------------------------- |
| Anthropic                  | Claude Code (`claude`)           | Messages API                                                  |
| OpenAI                     | Codex CLI (`codex`)              | Chat Completions                                              |
| Google                     | Gemini CLI (`gemini`)            | Gemini API                                                    |
| xAI                        | Grok Build CLI (`grok`)          | OpenAI-compatible                                             |
| Anything OpenAI-compatible | —                                | OpenRouter, Groq, Together, Ollama, LM Studio, vLLM, LiteLLM… |

Wire-format translation is built in: a request in OpenAI shape can be served by an Anthropic account and vice versa (text, images, tools, tool results, streaming). The CLI lane is text-only by nature. See [docs/PROVIDERS.md](docs/PROVIDERS.md) for what has been verified against real CLIs and what is best-effort.

## Design principles

- **Original, small, boring.** One data model, one router, adapters that are data more than code. No framework, no ORM, no native modules.
- **Vendor tooling does the sensitive part.** Sign-in is the vendor's sign-in. Subscription tokens stay in the vendor's own files, in a directory this library created for that account.
- **Same provider only.** Data you send to Claude does not end up at OpenAI because a limit was hit.
- **Everything observable.** Every park, switch, login step and request is an event; the UI, the proxy's SSE feed and your logs see the same stream.
- **Portable.** The same profile store, vault and router run in Electron, a daemon, a CLI, or tests.

## Repository

```
packages/core      engine (zero deps)         packages/electron  main + preload + keychain protector
packages/proxy     local HTTP server + client packages/react     hook + styled AccountSwitcher
packages/cli       `iron-proxy` binary        examples/electron-host  minimal wired app
docs/              architecture, adopting, providers, failover, roadmap
```

- [Architecture](docs/ARCHITECTURE.md) · [Adopting](docs/ADOPTING.md) · [Providers](docs/PROVIDERS.md) · [Failover](docs/FAILOVER.md) · [Roadmap](docs/ROADMAP.md)
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

## Status

Pre-1.0. The engine, translators, vault, router and CLI lane are tested against a fake vendor CLI and fake HTTP providers on Windows, macOS and Linux in CI. Live verification against real subscriptions is tracked per provider in [docs/PROVIDERS.md](docs/PROVIDERS.md).

## License

[MIT](LICENSE) © RealDealCPA
