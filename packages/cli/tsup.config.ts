import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: true,
    clean: true,
    target: 'node20',
    platform: 'node',
    external: ['@iron-proxy/core', '@iron-proxy/proxy'],
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    target: 'node20',
    platform: 'node',
    external: ['@iron-proxy/core', '@iron-proxy/proxy'],
  },
]);
