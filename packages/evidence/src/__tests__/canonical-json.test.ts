// =============================================================================
// Tests für canonical-json — die Grundlage der Hash-Chain.
//
// Prüft, dass semantisch gleiche Inputs IMMER zu byte-identischer Ausgabe
// führen. Wenn das bricht, brechen alle hash-versiegelten Audit-Logs.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../canonical-json';

describe('canonicalJson — Determinismus', () => {
  it('Object-Keys werden alphabetisch sortiert', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('Verschachtelte Objekte werden rekursiv sortiert', () => {
    const a = { outer: { z: 1, a: 2 }, top: 3 };
    const b = { top: 3, outer: { a: 2, z: 1 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"outer":{"a":2,"z":1},"top":3}');
  });

  it('null-Werte bleiben erhalten', () => {
    expect(canonicalJson({ a: null, b: 1 })).toBe('{"a":null,"b":1}');
  });

  it('undefined-Werte werden ausgelassen', () => {
    const obj: Record<string, unknown> = { a: 1, b: undefined, c: 2 };
    expect(canonicalJson(obj)).toBe('{"a":1,"c":2}');
  });

  it('Top-Level undefined wird zu null', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('Date wird als ISO-8601-String serialisiert', () => {
    const d = new Date(Date.UTC(2025, 0, 15, 10, 30, 45));
    expect(canonicalJson({ at: d })).toBe('{"at":"2025-01-15T10:30:45.000Z"}');
  });

  it('Buffer/Uint8Array wird als hex:-Präfix serialisiert', () => {
    const buf = Buffer.from([0xab, 0xcd, 0xef]);
    expect(canonicalJson({ hash: buf })).toBe('{"hash":"hex:abcdef"}');
  });

  it('BigInt wird als String serialisiert', () => {
    expect(canonicalJson({ id: BigInt(12345678901234) })).toBe('{"id":"12345678901234"}');
  });

  it('Arrays behalten ihre Reihenfolge', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('Verschachtelte Arrays', () => {
    expect(canonicalJson({ list: [{ b: 1, a: 2 }, { d: 3 }] })).toBe(
      '{"list":[{"a":2,"b":1},{"d":3}]}',
    );
  });

  it('Strings werden JSON-escaped', () => {
    expect(canonicalJson({ s: 'a"b\nc' })).toBe('{"s":"a\\"b\\nc"}');
  });

  it('Whitespaces sind nirgends im Output', () => {
    const s = canonicalJson({ a: 1, b: [1, 2], c: { d: 'e' } });
    expect(s).not.toMatch(/\s/);
  });

  it('Boolean-Werte', () => {
    expect(canonicalJson({ a: true, b: false })).toBe('{"a":true,"b":false}');
  });

  it('NaN/Infinity werden abgelehnt', () => {
    expect(() => canonicalJson({ x: NaN })).toThrow();
    expect(() => canonicalJson({ x: Infinity })).toThrow();
  });
});

describe('canonicalJson — typische Audit-Event-Struktur', () => {
  it('Reproduzierbar mit allen Feldern eines Audit-Events', () => {
    const event = {
      tenantId: 't1',
      occurredAt: new Date('2025-05-10T12:00:00.000Z'),
      actorType: 'STAFF',
      actorId: 's1',
      action: 'document.upload',
      resourceType: 'document',
      resourceId: 'd1',
      after: { title: 'Rechnung 2025-001', sizeBytes: 12345 },
    };
    const a = canonicalJson(event);
    const b = canonicalJson({
      after: { sizeBytes: 12345, title: 'Rechnung 2025-001' },
      actorId: 's1',
      action: 'document.upload',
      actorType: 'STAFF',
      occurredAt: new Date('2025-05-10T12:00:00.000Z'),
      resourceId: 'd1',
      resourceType: 'document',
      tenantId: 't1',
    });
    expect(a).toBe(b);
  });

  it('Eingebettete Buffer (z. B. SHA-256) deterministisch', () => {
    const sha = Buffer.from('deadbeef'.repeat(8), 'hex');
    const a = canonicalJson({ hash: sha, label: 'A' });
    const b = canonicalJson({ label: 'A', hash: sha });
    expect(a).toBe(b);
    expect(a).toContain('"hash":"hex:deadbeef');
  });
});
