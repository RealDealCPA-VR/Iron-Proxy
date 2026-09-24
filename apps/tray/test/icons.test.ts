import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = join(root, 'assets');

const EXPECTED: Record<string, number> = {
  'trayTemplate.png': 16,
  'trayTemplate@2x.png': 32,
  'trayTemplate@4x.png': 64,
  'tray.png': 16,
  'tray@2x.png': 32,
  'tray@4x.png': 64,
  'icon-256.png': 256,
  'icon-512.png': 512,
};

/** Width, height, colour type and the raw RGBA of a PNG this script wrote. */
function decode(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9]!;
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, colorType, raw };
}

let out: string;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'iron-tray-icons-'));
});
afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

describe('icons', () => {
  it('the committed PNGs are exactly what scripts/make-icons.mjs draws', async () => {
    await promisify(execFile)(process.execPath, [
      join(root, 'scripts', 'make-icons.mjs'),
      '--out',
      out,
    ]);
    const made = (await readdir(out)).sort();
    expect(made).toEqual(Object.keys(EXPECTED).sort());
    for (const name of made) {
      const fresh = await readFile(join(out, name));
      const committed = await readFile(join(assets, name));
      expect(committed.equals(fresh), `${name} is stale: run pnpm -F @iron-proxy/tray icons`).toBe(
        true,
      );
    }
  });

  it('are RGBA at the stated sizes; the template icon is pure black with alpha', async () => {
    for (const [name, size] of Object.entries(EXPECTED)) {
      const { width, height, colorType, raw } = decode(await readFile(join(assets, name)));
      expect([name, width, height, colorType]).toEqual([name, size, size, 6]);
      expect(raw.length).toBe(size * (size * 4 + 1));
      if (name.startsWith('trayTemplate')) {
        for (let y = 0; y < size; y++) {
          const row = raw.subarray(y * (size * 4 + 1) + 1, (y + 1) * (size * 4 + 1));
          for (let x = 0; x < size; x++) {
            expect(row[x * 4]! | row[x * 4 + 1]! | row[x * 4 + 2]!).toBe(0);
          }
        }
      }
    }
  });
});
