import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
