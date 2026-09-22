# Security policy

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository (Security → Advisories). Do not open a public issue for anything that could expose credentials or let one account be used as another. You will get an acknowledgement within a week.

## What Iron-Proxy protects, and how

| Asset                    | Protection                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API keys                 | AES-256-GCM in `vault.json`, one IV per entry, the entry's reference bound as AAD so ciphertexts cannot be swapped between accounts.                                                                                                                                                                                               |
| Vault master key         | `vault.key`, mode 0600. In Electron it is wrapped by `safeStorage` (Windows DPAPI, macOS Keychain, Linux libsecret), so the file is useless on another machine or user account. Outside Electron it is a plain key file protected by filesystem permissions; the key file records which protector wrote it and refuses a mismatch. |
| Subscription credentials | Never touched. They live in the vendor CLI's own files inside a per-account directory Iron-Proxy created, with the vendor's own permissions and refresh logic.                                                                                                                                                                     |
| Environment              | Vendor CLIs are spawned with a scrubbed environment: only PATH/HOME/temp/proxy variables and the home override. `*_API_KEY` variables are stripped so an inherited key cannot silently bypass the subscription.                                                                                                                    |
| Control API              | Loopback bind by default. `/iron/*` routes require the bearer token generated at start (or supplied by the host).                                                                                                                                                                                                                  |
| Logs and UI text         | `redactSecrets()` runs on CLI output and error bodies before they reach events or messages.                                                                                                                                                                                                                                        |

## What it does not protect against

- An attacker running as your user on your machine. They can read the key file (or ask DPAPI to unwrap it) and can run the vendor CLIs from the isolated homes. This is the same exposure the vendor CLIs have on their own.
- A malicious vendor CLI. Iron-Proxy executes whatever `claude`, `codex`, `grok`, `gemini` resolve to on PATH (or the binary you configured).
- Requests you send. Prompts go to the provider you chose; Iron-Proxy never re-routes them to another provider.

## Dependencies

`@iron-proxy/core` and `@iron-proxy/proxy` have zero runtime dependencies. The React package depends on React only. CI runs on a lockfile.
