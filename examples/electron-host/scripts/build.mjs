// Bundles main, preload and renderer with esbuild. No Electron binary needed to build.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'out');
await mkdir(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', absWorkingDir: root };

await Promise.all([
  build({
    ...common,
    entryPoints: [join(root, 'src/main.ts')],
    outfile: join(out, 'main.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/preload.ts')],
    outfile: join(out, 'preload.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [join(root, 'src/renderer.tsx')],
    outfile: join(out, 'renderer.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
  copyFile(join(root, 'src/index.html'), join(out, 'index.html')),
]);
