// A second process on the same data directory, for test/multiprocess.test.ts.
// Uses the built package (dist), exactly as the CLI and the tray app do.
//
//   node store-child.mjs <dataDir> <job> <prefix> <count>
//
// Loads its store first (so it holds a cache, like a long-running tray), prints
// "ready", waits for <dataDir>/go, then runs the job and prints "done".
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileProfileStore, FileStateStore, FileUsageStore } from '../../dist/index.js';

const [dataDir, job, prefix, countArg] = process.argv.slice(2);
const count = Number(countArg);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = (id, order) => ({
  id,
  title: `P ${id}`,
  provider: 'anthropic',
  lane: 'api-key',
  order,
  enabled: true,
  apiKey: { secretRef: `apikey:${id}` },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const profiles = new FileProfileStore(dataDir);
const states = new FileStateStore(dataDir, { debounceMs: 1 });
const usage = new FileUsageStore(dataDir, { debounceMs: 1 });
await profiles.list();
await states.all();
await usage.all();

process.stdout.write('ready\n');
while (!existsSync(join(dataDir, 'go'))) await wait(5);

for (let i = 0; i < count; i++) {
  const id = `${prefix}${i}`;
  switch (job) {
    case 'put-profiles':
      await profiles.put(profile(id, i));
      break;
    case 'delete-profiles':
      await profiles.delete(id);
      break;
    case 'put-states':
      await states.put({ profileId: id, status: 'parked', served: i, parkedUntil: 'later' });
      if (i % 3 === 2) await states.flush();
      break;
    case 'delete-states':
      await states.delete(id);
      if (i % 3 === 2) await states.flush();
      break;
    case 'add-usage':
      // One history of its own, and one both processes append to.
      await usage.addRequest(prefix, { at: new Date().toISOString(), durationMs: i });
      await usage.addRequest('shared', { at: new Date().toISOString(), durationMs: i });
      if (i % 3 === 2) await usage.flush();
      break;
    default:
      throw new Error(`unknown job ${job}`);
  }
  await wait(Math.floor(Math.random() * 3));
}
await states.flush();
await usage.flush();
process.stdout.write('done\n');
