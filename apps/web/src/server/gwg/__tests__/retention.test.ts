import { describe, it, expect } from 'vitest';
import { gwgDeletionDeadline, isGwgDeletionDue, GWG_RETENTION_YEARS } from '../retention';

describe('gwgDeletionDeadline — § 8 Abs. 4 (Jahresende + 5 J.)', () => {
  it('Mandatsende 2026-03-15 → fällig ab 2032-01-01', () => {
    expect(gwgDeletionDeadline(new Date('2026-03-15T10:00:00Z')).toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });

  it('Jahresanfang zählt zum Vorjahres-Schluss: 2026-01-01 → 2032-01-01', () => {
    // Frist beginnt mit Schluss des Kalenderjahres 2026, nicht ab dem Tag.
    expect(gwgDeletionDeadline(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });

  it('Silvester 2026-12-31 → noch Kalenderjahr 2026 → 2032-01-01', () => {
    expect(gwgDeletionDeadline(new Date('2026-12-31T23:59:00Z')).toISOString()).toBe('2032-01-01T00:00:00.000Z');
  });

  it('verwendet GWG_RETENTION_YEARS (5)', () => {
    expect(GWG_RETENTION_YEARS).toBe(5);
  });
});

describe('isGwgDeletionDue', () => {
  const mandateEnd = new Date('2026-06-01T00:00:00Z'); // fällig ab 2032-01-01

  it('false ohne Mandatsende', () => {
    expect(isGwgDeletionDue(null)).toBe(false);
    expect(isGwgDeletionDue(undefined)).toBe(false);
  });

  it('false vor dem Stichtag (ein Tag davor)', () => {
    expect(isGwgDeletionDue(mandateEnd, new Date('2031-12-31T23:59:59Z'))).toBe(false);
  });

  it('true am Stichtag', () => {
    expect(isGwgDeletionDue(mandateEnd, new Date('2032-01-01T00:00:00Z'))).toBe(true);
  });

  it('true lange nach dem Stichtag', () => {
    expect(isGwgDeletionDue(mandateEnd, new Date('2040-01-01T00:00:00Z'))).toBe(true);
  });
});
