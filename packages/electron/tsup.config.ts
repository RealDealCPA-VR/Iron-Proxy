import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts', preload: 'src/preload.ts', renderer: 'src/renderer.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  external: ['electron', '@iron-proxy/core'],
});
