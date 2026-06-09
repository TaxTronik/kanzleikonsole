import { describe, it, expect } from 'vitest';
import { sanitizeZipFileName } from '../zip';

describe('sanitizeZipFileName — Zip-Slip-Härtung', () => {
  it('ersetzt Pfad-Trenner und Steuerzeichen', () => {
    expect(sanitizeZipFileName('a/b\\c')).toBe('a_b_c');
    expect(sanitizeZipFileName('a\x00b')).toBe('a_b');
  });

  it('neutralisiert reine Punkt-Segmente (., ..) — kein Pfad-Navigations-Segment', () => {
    expect(sanitizeZipFileName('.')).toBe('datei');
    expect(sanitizeZipFileName('..')).toBe('datei');
    expect(sanitizeZipFileName('...')).toBe('datei');
    expect(sanitizeZipFileName(' .. ')).toBe('datei');
  });

  it('ersetzt führende Punkte (keine versteckten Dotfiles)', () => {
    expect(sanitizeZipFileName('.htaccess')).toBe('_htaccess');
    expect(sanitizeZipFileName('..geheim')).toBe('_geheim');
  });

  it('"../" wird durch den Slash-Replace zum harmlosen Segment', () => {
    // '/' → '_' ⇒ '.._etc_passwd', führende Punkte → '_'
    expect(sanitizeZipFileName('../etc/passwd')).toBe('__etc_passwd');
  });

  it('leerer/whitespace-Name → Fallback', () => {
    expect(sanitizeZipFileName('')).toBe('datei');
    expect(sanitizeZipFileName('   ')).toBe('datei');
  });

  it('kürzt auf maxLen', () => {
    expect(sanitizeZipFileName('x'.repeat(200), 10)).toBe('x'.repeat(10));
  });
});
