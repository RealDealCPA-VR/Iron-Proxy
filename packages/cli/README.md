# iron-proxy (CLI)

Command line for [Iron-Proxy](https://github.com/RealDealCPA-VR/Iron-Proxy): run the local account-switching proxy, add and log in AI provider accounts, check status, chat.

```bash
npx iron-proxy doctor                               # which vendor CLIs are installed
npx iron-proxy profiles add --provider anthropic --lane cli --title "Work Claude Max"
npx iron-proxy login <id>                           # prints the sign-in link and code
npx iron-proxy profiles add --provider openai --lane api-key --title "Backup key" --api-key-stdin < key.txt
npx iron-proxy status
npx iron-proxy chat anthropic "Hello"               # streams; says which account served
npx iron-proxy serve --port 8791                    # OpenAI- and Anthropic-compatible endpoints
```

`serve` writes `<dataDir>/proxy.json` (`{url, token, pid}`) so other processes can find the running proxy, and removes it on exit. Data lives in `~/.iron-proxy` or `--data-dir` / `IRON_PROXY_DATA_DIR`. Secrets are never printed.
