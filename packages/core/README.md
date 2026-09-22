# @iron-proxy/core

The engine behind [Iron-Proxy](https://github.com/RealDealCPA-VR/Iron-Proxy): titled accounts per AI provider, an encrypted vault, adapters for Anthropic / OpenAI / Google / xAI / OpenAI-compatible endpoints, and a router that fails over between accounts of the same provider on quota signals and returns to the primary when its window resets. Zero runtime dependencies. Node 20+.

```ts
import { createIronProxy } from '@iron-proxy/core';

const iron = createIronProxy({ dataDir });
const p = await iron.createProfile({
  title: 'Work Claude Max',
  provider: 'anthropic',
  lane: 'cli',
});
await (
  await iron.login(p.id)
).done;
const res = await iron.complete({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
});
```

Full documentation, the failover contract and the provider matrix live in the repository's `docs/` folder.
