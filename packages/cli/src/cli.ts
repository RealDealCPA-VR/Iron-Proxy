import { runCli } from './commands.js';

runCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr }).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${(err as Error).message ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
