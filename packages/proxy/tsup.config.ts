import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: { index: 'src/index.ts', client: 'src/client.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'neutral',
  define: { __IRON_PROXY_VERSION__: JSON.stringify(version) },
  external: ['@iron-proxy/core', /^node:/],
});
