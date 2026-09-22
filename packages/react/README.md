# @iron-proxy/react

The drop-in account switcher for [Iron-Proxy](https://github.com/RealDealCPA-VR/Iron-Proxy): accounts grouped by provider, titled inline, reordered with buttons or Alt+Arrow keys, toggled, logged in through the vendor's own flow (link + code shown right in the panel), with usage bars, parked countdowns and an "all accounts parked" banner. Light and dark, keyboard accessible, works at 320px, no dependencies beyond React.

```tsx
import { AccountSwitcher } from '@iron-proxy/react';

<AccountSwitcher client={client} />;
```

`client` is any `IronClient`: `window.ironProxy` from `@iron-proxy/electron/renderer`, `HttpIronClient` from `@iron-proxy/proxy/client`, or `LocalIronClient` from `@iron-proxy/core`.

Props: `providers` (restrict), `compact`, `onServed(profileId)`, `onOpenTerminal(cmd)` (Electron hosts), `labels` (override any string), `theme: 'light' | 'dark'`, `injectStyles` (default true; set false and import `@iron-proxy/react/styles.css` yourself), `className`. Every colour and spacing is a CSS custom property on `.iron-switcher`.

Hooks for custom UIs: `useIronProxy(client)` returns profiles, states, login progress, exhausted providers and every action; `useCountdown(iso)` ticks only while something is parked.
