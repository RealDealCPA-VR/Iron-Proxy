# @iron-proxy/react

The drop-in account switcher for [Iron-Proxy](https://github.com/RealDealCPA-VR/Iron-Proxy): accounts grouped by provider, titled inline, reordered with buttons or Alt+Arrow keys, toggled, logged in through the vendor's own flow (link + code shown right in the panel), with usage bars, parked countdowns and an "all accounts parked" banner. Light and dark, keyboard accessible, works at 320px, no dependencies beyond React.

```tsx
import { AccountSwitcher } from '@iron-proxy/react';

<AccountSwitcher client={client} />;
```

`client` is any `IronClient`: `window.ironProxy` from `@iron-proxy/electron/renderer`, `HttpIronClient` from `@iron-proxy/proxy/client`, or `LocalIronClient` from `@iron-proxy/core`.

Props: `providers` (restrict), `compact`, `onServed(profileId)`, `onOpenTerminal(cmd)` (Electron hosts), `labels` (override any string), `theme: 'light' | 'dark'`, `injectStyles` (default true; set false and import `@iron-proxy/react/styles.css` yourself), `className`. Every colour and spacing is a CSS custom property on `.iron-switcher`.

**Add account** first lists vendor CLIs already signed in on this computer under "Found on this computer", each with a one-click "Use this account" (no second login); adopted accounts carry an "Existing login" badge, and logging one out asks first because it signs that CLI out too. Error banners show the library's `hint` under the message.

The **Usage** button in the header shows the usage panel inside the switcher: per account, small bars for requests in the last 5h / 24h / 7d, tokens this week, parks this week and, when the trend supports one, "About 40 min left at this pace" (marked "rough estimate" while it rests on few readings). `<UsagePanel client={client} />` renders the same panel on its own (props: `profileId`, `providers`, `refreshMs`, `labels`, `theme`, `injectStyles`, `className`); every string is in `defaultLabels` (`usage*`).

Hooks for custom UIs: `useUsageReport(client, { refreshMs?, debounceMs?, profileId? })` loads `client.usageReport()` and reloads it, debounced, after `request.finished` and `profile.parked` events (plus on an interval when `refreshMs` is set; it reads local history, never a provider). `useIronProxy(client)` returns profiles, states, login progress, exhausted providers and every action; `useCountdown(iso)` ticks only while something is parked.
