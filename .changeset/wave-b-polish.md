---
'@iron-proxy/core': patch
'@iron-proxy/react': patch
'iron-proxy': patch
---

Small fixes from the wave B review.

- `iron-proxy profiles adopt` runs the vendor CLI's status check once, not twice: `adoptLogin()` already checks, and the CLI reads the stored state. The stderr "not signed in yet" note is unchanged.
- Resuming a cut-off stream when the caller's request already ends with an assistant turn (a prefill) adds the partial text to that turn on every lane, so a continuation never has two assistant turns in a row; lanes other than the Anthropic API still get the continue instruction after it.
- New `Router.settleUsage()`, which resolves once every usage snapshot a lane reported is stored and recorded. `IronProxy.usageReport()` and `close()` await it, so a report taken right after a request (even a failed one whose headers carried usage) includes its sample.
- `UsageStore` has an optional `flush(): Promise<void>`, which `close()` calls after the last usage write.
- Usage stores age out every profile on every write, so an idle profile's records older than 14 days are dropped too (the 5000-record trim still applies to the profile being written).
- React: `<UsagePanel>` shows the error banner (message, code, hint) when `usageReport` fails, instead of "No usage recorded yet." `<ErrorBanner>` takes an optional `labels` prop and works outside `<AccountSwitcher>`.
- Docs: pre-emptive switching applies to accounts whose lane reports a usage window, today the API-key lanes via rate-limit headers; subscription (CLI) accounts switch on the vendor's own limit message.
