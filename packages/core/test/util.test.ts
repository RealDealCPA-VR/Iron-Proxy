import { describe, expect, it } from 'vitest';
import { inferProvider, parseDurationMs, parseResetAt, redactSecrets, newId } from '../src/util.js';

describe('parseDurationMs', () => {
  it.each([
    ['6m0s', 360_000],
    ['1.5s', 1500],
    ['250ms', 250],
    ['2h', 7_200_000],
    ['1h30m', 5_400_000],
    ['45', 45_000],
    ['45 seconds', 45_000],
    ['3 hours 20 minutes', 12_000_000],
    ['31s', 31_000],
  ])('%s -> %d', (input, ms) => {
    expect(parseDurationMs(input)).toBe(ms);
  });
  it('returns undefined for junk', () => {
    expect(parseDurationMs('soon')).toBeUndefined();
    expect(parseDurationMs('')).toBeUndefined();
    expect(parseDurationMs(undefined)).toBeUndefined();
  });
});

describe('parseResetAt', () => {
  const now = new Date('2026-09-22T14:00:00.000Z').getTime();
  it('parses ISO', () => {
    expect(parseResetAt('2026-09-22T15:00:00Z', now)).toBe('2026-09-22T15:00:00.000Z');
  });
  it('parses unix seconds and millis', () => {
    expect(parseResetAt('1790000000', now)).toBe(new Date(1_790_000_000_000).toISOString());
    expect(parseResetAt('1790000000000', now)).toBe(new Date(1_790_000_000_000).toISOString());
  });
  it('parses a clock phrase as the next such local time', () => {
    const r = parseResetAt('3pm', now);
    expect(r).toBeDefined();
    const d = new Date(r!);
    expect(d.getHours()).toBe(15);
    expect(d.getTime()).toBeGreaterThan(now);
  });
  it('rejects nonsense', () => {
    expect(parseResetAt('never', now)).toBeUndefined();
  });
});

describe('inferProvider', () => {
  it.each([
    ['claude-sonnet-5', 'anthropic'],
    ['gpt-5', 'openai'],
    ['o3-mini', 'openai'],
    ['gemini-2.5-pro', 'google'],
    ['models/gemini-2.5-flash', 'google'],
    ['grok-4', 'xai'],
    ['llama3', undefined],
  ])('%s -> %s', (model, provider) => {
    expect(inferProvider(model)).toBe(provider);
  });
});

describe('redactSecrets', () => {
  it('hides API keys and bearer tokens', () => {
    const s = redactSecrets(
      'key sk-abcdefghijklmnopqrstuvwxyz012345 and Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    );
    expect(s).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(s).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz');
    expect(s).toContain('sk-abcdef');
  });
});

describe('newId', () => {
  it('is unique and prefixed', () => {
    const a = newId('p');
    const b = newId('p');
    expect(a).not.toBe(b);
    expect(a.startsWith('p_')).toBe(true);
  });
});
