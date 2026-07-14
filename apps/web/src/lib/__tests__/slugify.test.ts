import { describe, it, expect } from 'vitest';
import { slugify } from '../slugify';

describe('slugify', () => {
  it('lowercases and replaces spaces with default underscore', () => {
    expect(slugify('Hello World')).toBe('hello_world');
  });

  it('replaces German umlauts (NOT just strips them — preserves pronunciation)', () => {
    expect(slugify('Müller GmbH & Co. KG')).toBe('mueller_gmbh_co_kg');
    expect(slugify('Größe der Bäckerei')).toBe('groesse_der_baeckerei');
    expect(slugify('Straße')).toBe('strasse');
  });

  it('strips combining diacritics (NFD normalize)', () => {
    // U+00E9 (é) decomposes to U+0065 + U+0301 → "e"
    expect(slugify('Café')).toBe('cafe');
    expect(slugify('naïve')).toBe('naive');
  });

  it('collapses runs of separators and trims them at edges', () => {
    expect(slugify('  --hello---world  ')).toBe('hello_world');
    expect(slugify('___test___')).toBe('test');
  });

  it('supports dash separator (URL-friendly)', () => {
    expect(slugify('Hello World', { separator: '-' })).toBe('hello-world');
    expect(slugify('Müller AG', { separator: '-' })).toBe('mueller-ag');
  });

  it('truncates to maxLength', () => {
    expect(slugify('abcdefghij'.repeat(10), { maxLength: 25 })).toHaveLength(25);
  });

  it('prefixes when result starts with non-letter (identifier-safe)', () => {
    expect(slugify('123abc', { ensureLetterStart: 'f' })).toBe('f123abc');
    expect(slugify('abc123', { ensureLetterStart: 'f' })).toBe('abc123');
    expect(slugify('!!!', { ensureLetterStart: 'f' })).toBe('');
  });

  it('returns empty string for input containing only non-letters', () => {
    expect(slugify('   ')).toBe('');
    expect(slugify('!!!??')).toBe('');
  });

  it('handles mixed-case + special chars + length limit together', () => {
    expect(slugify('GmbH "Schöne Straße" Kontaktpersonen', { separator: '-', maxLength: 30 })).toBe(
      'gmbh-schoene-strasse-kontaktpe',
    );
  });
});
