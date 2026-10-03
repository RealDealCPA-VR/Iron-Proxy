import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/**
 * `pnpm --filter iron-proxy bundle`: the whole CLI as ONE ESM file,
 * `dist-bundle/iron-proxy.mjs`, with @iron-proxy/core and @iron-proxy/proxy
 * inlined (they have no runtime dependencies), for hosts that ship Iron-Proxy
 * inside their own app and run it with their own Node (or Electron as Node:
 * ELECTRON_RUN_AS_NODE=1). Not published to npm; a build artifact.
 */
export default defineConfig({
  entry: { 'iron-proxy': 'src/cli.ts' },
  outDir: 'dist-bundle',
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  sourcemap: false,
  splitting: false,
  target: 'node20',
  platform: 'node',
  define: { __IRON_PROXY_VERSION__: JSON.stringify(version) },
  noExternal: [/^@iron-proxy\//],
});
