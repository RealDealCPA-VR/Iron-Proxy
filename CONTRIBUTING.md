# Contributing

Thanks for helping. Iron-Proxy is small on purpose; the best contributions keep it that way.

## Setup

```bash
pnpm install
pnpm check          # build + typecheck + lint + test, all packages (build first: dependents typecheck against core's dist)
pnpm -F @iron-proxy/core test
```

Node 20.11+ and pnpm 10. No native modules, no Electron binary needed for the test suite (`ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set in `packages/electron/.npmrc`).

## Ground rules

- **Tests prove behaviour, not intent.** A failover test drives the real router with a scripted lane; a CLI test drives the real spawn path with the fake CLI in `packages/core/test/fixtures/fake-cli`. Do not stub the layer you are testing.
- **No cross-provider failover, ever.** PRs that add it will be closed with a link to docs/FAILOVER.md.
- **No token extraction from vendor files.** The subscription lane drives the vendor CLI. If a vendor ships a sanctioned programmatic auth, add it as a lane.
- **Zero runtime deps in core and proxy.** Argue in the PR if you think one is worth it.
- **Secrets never reach logs, events or UI.** Run new output through `redactSecrets` and add a test.
- **Every user-visible change has a changeset** (`pnpm changeset`).

## Adding a provider or CLI

See docs/PROVIDERS.md → "Adding a provider". Add the fake CLI flavour and the `describe.each` entry so the new spec runs through the same tests as the others. Record what you verified live in docs/PROVIDERS.md.

## Style

Prettier and ESLint are configured; `pnpm format` before pushing. TypeScript is strict with `exactOptionalPropertyTypes`, so spread optional properties conditionally rather than assigning `undefined`.

## Pull requests

Small and focused. Describe the behaviour change, name the test that proves it, and say what you did not verify.
