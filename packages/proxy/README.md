# @iron-proxy/proxy

A localhost server in front of [`@iron-proxy/core`](https://github.com/RealDealCPA-VR/Iron-Proxy): **OpenAI-compatible** (`/v1/chat/completions`, `/v1/models`) and **Anthropic-compatible** (`/v1/messages`) endpoints that fail over between your accounts of the same provider, plus a bearer-token control API (`/iron/*`) and an SSE event feed. Zero runtime dependencies.

```ts
import { createIronProxy } from '@iron-proxy/core';
import { createProxyServer } from '@iron-proxy/proxy';

const proxy = createProxyServer({ iron: createIronProxy(), port: 8791 });
const { url, token } = await proxy.listen();
// OpenAI SDK:    baseURL `${url}/v1`      Anthropic SDK: baseURL url
```

Headers: `x-iron-provider` forces a provider, `x-iron-profile` pins an account, `x-iron-resume: 1` continues a streamed answer on the next account when a limit cuts it off mid-stream (the switch comment then ends in `resumed`; `0` turns a policy default off), `authorization: Bearer <token>` unlocks `/iron/*`.

Error bodies keep each dialect's shape and add an `iron` object: `{ code, retryable, details, hint }`, where `hint` is one sentence telling the user what to do next. `GET /iron/discover` lists vendor CLIs already signed in on this machine; `POST /iron/adopt` (`{ provider, home, title? }`) turns one into a profile in place. `GET /iron/usage[?profileId=]` returns the usage report (requests and tokens per window, parks this week, the time-left estimate when there is one); `HttpIronClient.usageReport(profileId?)` calls it.

**External-executor API**, for hosts that run the vendor CLI themselves and use Iron-Proxy as the account manager: `GET /iron/pick?provider=<id>[&lane=cli][&profileId=<id>]` answers `{ profile, env: { set, unset } }` (the account to use now, or exactly the account `profileId` names or an error saying why it cannot be used, and the variables that run its CLI as it); `POST /iron/profiles/:id/signal` (`{ status?, headers?, text? }`) lets Iron-Proxy's own detectors classify a failure and park the account on a quota signal (`{ parked: true, signal, state }` or `{ parked: false }`); `POST /iron/profiles/:id/finished` (`{ usage?, durationMs?, model? }`) records a success like an internal one (`{ ok: true, state }`). `HttpIronClient.pick / signal / finished` call them; they are not on `IronClient`. `GET /iron/health` (no token) answers `{ ok, name, profiles, version, features }`; use the executor routes only when `features` contains `executor-v1` (an older proxy with the same version has no `features`), and `profileId` only when it also contains `pick-profile`. Errors, codes and details: docs/ADOPTING.md, "Running the vendor CLI yourself".

The HTTP client implements the same `IronClient` the React switcher and the Electron bridge use:

```ts
import { HttpIronClient } from '@iron-proxy/proxy/client';
const client = new HttpIronClient(url, token);
// Failures throw HttpIronClientError with .status, .code, .details and .hint.
```

Or just run it: `npx iron-proxy serve`. Full docs in the repository's `docs/` folder.
