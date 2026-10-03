import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  define: { __IRON_PROXY_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      '@iron-proxy/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@iron-proxy/proxy': fileURLToPath(new URL('../proxy/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
