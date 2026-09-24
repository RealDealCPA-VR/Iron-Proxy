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

Already signed in to a vendor CLI? `iron.discoverLogins()` lists existing logins at the CLIs' default homes (checked with their own status commands, credential files never read), and `iron.adoptLogin({ provider, home })` turns one into a profile in place. Every `IronProxyError` has a `hint` telling the user what to do next.

`iron.pickProfile(provider, { profileId?, lane? })` returns the account a request would use first right now (enabled, cli lane by default, not parked, signed in, lowest order), clearing expired parks exactly as the router does; `iron.interactiveCommand(id, args)` and `iron.shellEnv(id)` give the command and variables that start that account's vendor CLI from the user's own terminal (what `iron-proxy run` and `iron-proxy env` use).

Full documentation, the failover contract and the provider matrix live in the repository's `docs/` folder.
