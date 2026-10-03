import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const define = { __IRON_PROXY_VERSION__: JSON.stringify(version) };

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    clean: true,
    target: 'node20',
    platform: 'node',
    define,
    external: ['@iron-proxy/core', '@iron-proxy/proxy'],
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'node20',
    platform: 'node',
    define,
    external: ['@iron-proxy/core', '@iron-proxy/proxy'],
  },
]);
