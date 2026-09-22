# @iron-proxy/proxy

A localhost server in front of [`@iron-proxy/core`](https://github.com/RealDealCPA-VR/Iron-Proxy): **OpenAI-compatible** (`/v1/chat/completions`, `/v1/models`) and **Anthropic-compatible** (`/v1/messages`) endpoints that fail over between your accounts of the same provider, plus a bearer-token control API (`/iron/*`) and an SSE event feed. Zero runtime dependencies.

```ts
import { createIronProxy } from '@iron-proxy/core';
import { createProxyServer } from '@iron-proxy/proxy';

const proxy = createProxyServer({ iron: createIronProxy(), port: 8791 });
const { url, token } = await proxy.listen();
// OpenAI SDK:    baseURL `${url}/v1`      Anthropic SDK: baseURL url
```

Headers: `x-iron-provider` forces a provider, `x-iron-profile` pins an account, `authorization: Bearer <token>` unlocks `/iron/*`.

The HTTP client implements the same `IronClient` the React switcher and the Electron bridge use:

```ts
import { HttpIronClient } from '@iron-proxy/proxy/client';
const client = new HttpIronClient(url, token);
```

Or just run it: `npx iron-proxy serve`. Full docs in the repository's `docs/` folder.
