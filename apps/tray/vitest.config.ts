import { defineConfig } from 'vitest/config';

// Plain Node by default; the renderer test opts into jsdom with a file comment.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: { provider: 'v8', include: ['src/**'] },
  },
});
