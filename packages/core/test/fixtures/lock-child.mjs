// A waiter racing others for one lock file, for test/multiprocess.test.ts.
//
//   node lock-child.mjs <fileLockModule> <dir> <name> <rounds>
//
// <fileLockModule> is src/store/file-lock.ts compiled to plain JavaScript by the
// test. Each round the child prints "ready <round>", waits for <dir>/go-<round>
// (the test has put a stale lock in place by then), takes the lock on
// <dir>/data.json and, while holding it, appends "enter <name>" and
// "leave <name>" to <dir>/log with a short pause in between.
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePath, dir, name, roundsArg] = process.argv.slice(2);
const { withFileLock } = await import(pathToFileURL(modulePath).href);
const rounds = Number(roundsArg);
const log = join(dir, 'log');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (let round = 0; round < rounds; round++) {
  process.stdout.write(`ready ${round}\n`);
  const go = join(dir, `go-${round}`);
  // Spin rather than sleep, so every waiter starts within a moment of the others.
  while (!existsSync(go)) {
    /* spin */
  }
  await withFileLock(
    join(dir, 'data.json'),
    async () => {
      appendFileSync(log, `enter ${name}\n`);
      await wait(15);
      appendFileSync(log, `leave ${name}\n`);
    },
    { timeoutMs: 20_000 },
  );
}
process.stdout.write('done\n');
