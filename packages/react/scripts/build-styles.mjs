// Turns src/styles.css into src/styles.generated.ts (a string export the
// component injects at runtime) and, with --copy, copies the CSS into dist/.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const out = `// Generated from styles.css by scripts/build-styles.mjs. Do not edit.\nexport const css: string = ${JSON.stringify(css)};\n`;
const target = join(root, 'src/styles.generated.ts');
if (!existsSync(target) || readFileSync(target, 'utf8') !== out) writeFileSync(target, out);
if (process.argv.includes('--copy')) {
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(join(root, 'src/styles.css'), join(root, 'dist/styles.css'));
}
