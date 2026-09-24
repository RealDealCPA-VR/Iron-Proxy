import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process';

/** The slice of `child_process.spawn` the CLI uses; injectable through CliIo for tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: NodeSpawnOptions,
) => ChildProcess;

export interface LaunchSpec {
  command: string;
  args: string[];
  /** Set when the command line was quoted by hand for cmd.exe. */
  windowsVerbatimArguments?: boolean;
}

// cmd.exe metacharacters, escaped with ^ (the approach cross-spawn uses).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escape the program path for a `cmd.exe /s /c "..."` line. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

/**
 * Quote one argument for a `cmd.exe /s /c "..."` line that runs a .cmd/.bat
 * shim. First the CommandLineToArgvW rules (backslashes before a quote are
 * doubled, the quote is escaped), then the whole thing is wrapped in quotes and
 * every cmd metacharacter, the quotes included, is escaped with ^. The escaping
 * is applied twice because a shim forwards its arguments with %*, which cmd
 * parses a second time.
 */
export function escapeCmdArgument(arg: string, doubleEscape = true): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(CMD_META, '^$1');
  if (doubleEscape) a = a.replace(CMD_META, '^$1');
  return a;
}

/**
 * How to start `resolved` (an absolute path, from core's `which`) with `args`,
 * without a shell. On Windows a .cmd/.bat shim cannot be started directly, so
 * it runs as `cmd.exe /d /s /c "<quoted line>"` with every part escaped.
 */
export function buildLaunch(
  resolved: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec || 'cmd.exe',
): LaunchSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [escapeCmdCommand(resolved), ...args.map((a) => escapeCmdArgument(a))].join(' ');
    return {
      command: comspec,
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args };
}

/**
 * Start the command with the terminal attached and resolve with its exit code.
 * Ctrl+C belongs to the child while it runs, so this process ignores SIGINT
 * until the child exits.
 */
export function launchInteractive(
  spawn: SpawnFn,
  spec: LaunchSpec,
  env: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ignore = () => {};
    process.on('SIGINT', ignore);
    const done = () => process.off('SIGINT', ignore);
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        stdio: 'inherit',
        env,
        shell: false,
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (err) {
      done();
      reject(err);
      return;
    }
    child.once('error', (err) => {
      done();
      reject(err);
    });
    child.once('close', (code, signal) => {
      done();
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}
