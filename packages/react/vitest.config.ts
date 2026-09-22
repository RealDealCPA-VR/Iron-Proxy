import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
    coverage: { provider: 'v8', include: ['src/**'] },
  },
});
