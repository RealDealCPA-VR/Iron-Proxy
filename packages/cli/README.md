# iron-proxy (CLI)

Command line for [Iron-Proxy](https://github.com/RealDealCPA-VR/Iron-Proxy): run the local account-switching proxy, add and log in AI provider accounts, check status, chat.

```bash
npx iron-proxy setup                                # start here: guided first run (--yes: no questions)
npx iron-proxy doctor                               # which vendor CLIs are installed
npx iron-proxy profiles add --provider anthropic --lane cli --title "Work Claude Max"
npx iron-proxy login <id>                           # prints the sign-in link and code
npx iron-proxy profiles add --provider openai --lane api-key --title "Backup key" --api-key-stdin < key.txt
npx iron-proxy profiles discover                    # CLIs already signed in on this computer
npx iron-proxy profiles adopt anthropic             # use that login as-is (--home DIR, --title T)
npx iron-proxy status
npx iron-proxy chat anthropic "Hello"               # streams; says which account served
npx iron-proxy serve --port 8791                    # OpenAI- and Anthropic-compatible endpoints
npx iron-proxy run anthropic [-- args]              # the vendor CLI, interactively, as the ready account
npx iron-proxy env anthropic --shell bash           # lines that make your own shell use that account
```

`setup` walks through four steps: which vendor CLIs are installed (the official install command for each missing one), adopting signed-in logins it finds (`[Y/n]` each), adding more accounts (`[y/N]`: provider, lane, title, then the headless sign-in or the API key, read without echo and never printed), and the status table. `setup --yes` adopts every signed-in login without asking and exits 0.

`run <provider>` starts the vendor CLI as the account a request would use first right now, printing `Using "<title>" (<provider>)` on stderr, with the home variable set and every `*_API_KEY` removed, and exits with the CLI's exit code. `--profile id` picks the account; if that account is parked or signed out it is still used, with a stderr note (`Note: "<title>" is parked until <local time>; it may refuse requests.` or `Note: "<title>" is not signed in: iron-proxy login <id>`). `env <provider>` prints `export` (bash/zsh, the default off Windows), `$env:` (PowerShell, the default on Windows, so pass `--shell bash` for `eval` in Git Bash) or `set "..."` (cmd) lines for the home variable, and for bash and PowerShell lines that clear the API-key variables. An interactive session cannot switch accounts mid-session: when it hits a limit, quit and `run` again to get the next ready account.

`serve` writes `<dataDir>/proxy.json` (`{url, token, pid}`) so other processes can find the running proxy, and removes it on exit. Data lives in `~/.iron-proxy` or `--data-dir` / `IRON_PROXY_DATA_DIR`. Secrets are never printed.

Errors print as `CODE: message` followed by a `hint: …` line saying what to do next. `logout` on an adopted profile notes that it signed your own CLI out too, since it is the same login. Removing an adopted profile never deletes its directory.
