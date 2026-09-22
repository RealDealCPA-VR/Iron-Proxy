#!/usr/bin/env node
/**
 * Fake vendor CLI for tests. Emulates the headless output of claude / codex /
 * grok / gemini so the CLI lane and the router can be exercised without any
 * real account.
 *
 *   FAKE_CLI_FLAVOR   claude | codex | grok | gemini            (default claude)
 *   FAKE_CLI_MODE     ok | quota | auth | overload | crash | slow (default ok)
 *   FAKE_CLI_MARKER   file name inside the home dir that means "logged in"
 *
 * The home dir is read from the flavor's env var (CLAUDE_CONFIG_DIR, CODEX_HOME,
 * GROK_HOME, GEMINI_CLI_HOME). `login` creates the marker; `logout` removes it.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const flavor = process.env.FAKE_CLI_FLAVOR ?? 'claude';
const mode = process.env.FAKE_CLI_MODE ?? 'ok';
const homeEnv = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  grok: 'GROK_HOME',
  gemini: 'GEMINI_CLI_HOME',
}[flavor];
const home = process.env[homeEnv];
const marker = join(home ?? '.', process.env.FAKE_CLI_MARKER ?? 'logged-in');
const args = process.argv.slice(2);
const out = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
const err = (s) => process.stderr.write(s + '\n');

if (!home) {
  err(`fake-cli: ${homeEnv} not set`);
  process.exit(3);
}
mkdirSync(home, { recursive: true });
// Record every invocation so tests can assert on env isolation.
writeFileSync(
  join(home, 'last-invocation.json'),
  JSON.stringify({
    args,
    env: { [homeEnv]: home, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null },
  }),
);

const isStatus =
  (args[0] === 'auth' && args[1] === 'status') ||
  (args[0] === 'login' && args[1] === 'status') ||
  args[0] === 'models';
if (isStatus) {
  const logged = existsSync(marker);
  if (flavor === 'claude') out({ loggedIn: logged, authMethod: logged ? 'claude.ai' : 'none' });
  else if (flavor === 'codex') out(logged ? 'Logged in using ChatGPT' : 'Not logged in');
  else if (flavor === 'grok')
    out(logged ? 'Available models:\n  * grok-4 (default)' : 'You are not authenticated.');
  else out(logged ? 'OK' : 'not logged in');
  process.exit(0);
} else if (args[0] === 'login' || (args[0] === 'auth' && args[1] === 'login')) {
  out('Open this URL to sign in: https://example.test/device');
  out('Enter code: ABCD-1234');
  setTimeout(
    () => {
      writeFileSync(marker, 'yes');
      out('Login successful.');
      process.exit(0);
    },
    Number(process.env.FAKE_CLI_LOGIN_DELAY ?? 50),
  );
} else if (args[0] === 'logout' || (args[0] === 'auth' && args[1] === 'logout')) {
  if (existsSync(marker)) unlinkSync(marker);
  process.exit(0);
} else {
  // A headless turn.
  const logged = existsSync(marker);
  if (!logged || mode === 'auth') {
    quotaOrAuth('auth');
  } else if (mode === 'quota') {
    quotaOrAuth('quota');
  } else if (mode === 'overload') {
    err('Error: API overloaded (529). Please try again later.');
    process.exit(1);
  } else if (mode === 'crash') {
    err('Segmentation fault (fake)');
    process.exit(139);
  } else {
    readPrompt().then((prompt) => {
      const reply = `echo:${prompt.trim().split('\n').pop()}`;
      if (mode === 'slow') setTimeout(() => ok(reply), 30_000);
      else ok(reply);
    });
  }
}

async function readPrompt() {
  const i = args.indexOf('-p');
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  if (args.includes('-')) {
    let s = '';
    for await (const chunk of process.stdin) s += chunk;
    return s;
  }
  const pos = args.find(
    (a, idx) => !a.startsWith('-') && (idx === 0 || !args[idx - 1].startsWith('-')) && a !== 'exec',
  );
  return pos ?? '';
}

function ok(reply) {
  const usage = { input_tokens: 12, output_tokens: 3 };
  if (flavor === 'claude') {
    out({ type: 'system', subtype: 'init', session_id: 'fake' });
    for (const ch of reply.match(/.{1,4}/g) ?? [])
      out({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ch } },
      });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: reply, usage });
  } else if (flavor === 'codex') {
    out({ type: 'thread.started', thread_id: 'fake' });
    out({ type: 'turn.started' });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: reply } });
    out({ type: 'turn.completed', usage });
  } else if (flavor === 'grok') {
    for (const ch of reply.match(/.{1,4}/g) ?? [])
      out({ type: 'stream_event', event: { type: 'text_delta', delta: { text: ch } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
    out({ type: 'result', result: reply, usage });
  } else {
    out({ type: 'message', role: 'assistant', content: reply, delta: false });
    out({ type: 'result', response: reply, usage });
  }
  process.exit(0);
}

function quotaOrAuth(kind) {
  const msg =
    kind === 'auth'
      ? 'Not logged in. Please run login to authenticate.'
      : "You've hit your usage limit. Your limit will reset at 3pm.";
  if (flavor === 'claude') out({ type: 'result', subtype: 'error', is_error: true, result: msg });
  else if (flavor === 'codex') out({ type: 'error', message: msg });
  else if (flavor === 'grok') out({ type: 'error', message: msg });
  else out({ type: 'error', message: msg });
  process.exit(1);
}
