import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySettingsPatch,
  DEFAULT_PROXY_PORT,
  defaultSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  SETTINGS_FILE,
  toNotifierSettings,
} from '../src/logic/settings.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'iron-tray-settings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('tray settings', () => {
  it('defaults: every notification on, not at login, port 8791', async () => {
    expect(defaultSettings()).toEqual({
      notifications: {
        enabled: true,
        kinds: { switched: true, parked: true, exhausted: true, login: true },
      },
      startAtLogin: false,
      proxyPort: DEFAULT_PROXY_PORT,
    });
    expect(DEFAULT_PROXY_PORT).toBe(8791);
    // No file yet: defaults, and nothing is written by just reading.
    expect(await loadSettings(dir)).toEqual(defaultSettings());
    expect(await readdir(dir)).toEqual([]);
  });

  it('saves and loads round trip into tray-settings.json', async () => {
    const s = applySettingsPatch(defaultSettings(), {
      notifications: { enabled: false, kinds: { parked: false } },
      startAtLogin: true,
      proxyPort: 9911,
    });
    await saveSettings(dir, s);
    expect(await readdir(dir)).toEqual([SETTINGS_FILE]);
    const onDisk = JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8'));
    expect(onDisk).toEqual(s);
    expect(await loadSettings(dir)).toEqual({
      notifications: {
        enabled: false,
        kinds: { switched: true, parked: false, exhausted: true, login: true },
      },
      startAtLogin: true,
      proxyPort: 9911,
    });
  });

  it('creates the data directory when it does not exist yet', async () => {
    const nested = join(dir, 'fresh', 'data');
    await saveSettings(nested, defaultSettings());
    expect(await loadSettings(nested)).toEqual(defaultSettings());
  });

  it('falls back to defaults for a damaged file and for bad fields', async () => {
    await writeFile(join(dir, SETTINGS_FILE), '{ not json');
    expect(await loadSettings(dir)).toEqual(defaultSettings());

    await writeFile(
      join(dir, SETTINGS_FILE),
      JSON.stringify({
        notifications: { enabled: 'yes', kinds: { switched: false, bogus: false, login: 1 } },
        startAtLogin: 'true',
        proxyPort: 70000,
        extra: 'ignored',
      }),
    );
    const s = await loadSettings(dir);
    expect(s.notifications.enabled).toBe(true);
    expect(s.notifications.kinds).toEqual({
      switched: false,
      parked: true,
      exhausted: true,
      login: true,
    });
    expect(s.startAtLogin).toBe(false);
    expect(s.proxyPort).toBe(8791);
    expect(s).not.toHaveProperty('extra');
    expect(normalizeSettings(null)).toEqual(defaultSettings());
    expect(normalizeSettings([1, 2])).toEqual(defaultSettings());
  });

  it('applies a patch without touching other fields and ignores invalid values', () => {
    const base = applySettingsPatch(defaultSettings(), { proxyPort: 9000 });
    const next = applySettingsPatch(base, { notifications: { kinds: { login: false } } });
    expect(next.proxyPort).toBe(9000);
    expect(next.notifications.enabled).toBe(true);
    expect(next.notifications.kinds.login).toBe(false);
    expect(next.notifications.kinds.switched).toBe(true);
    expect(applySettingsPatch(next, { proxyPort: 0 }).proxyPort).toBe(9000);
    expect(applySettingsPatch(next, { proxyPort: 1.5 }).proxyPort).toBe(9000);
    expect(applySettingsPatch(next, 'garbage')).toEqual(next);
  });

  it('maps to the notifier settings', () => {
    const s = applySettingsPatch(defaultSettings(), {
      notifications: { enabled: true, kinds: { exhausted: false } },
    });
    expect(toNotifierSettings(s)).toEqual({
      enabled: true,
      kinds: { switched: true, parked: true, exhausted: false, login: true },
    });
  });
});
