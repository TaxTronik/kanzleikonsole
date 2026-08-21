// =============================================================================
// Hash-Chain-Determinismus (Review F1/A2) — MUSS in CI laufen.
//
// Kernrisiko: der Record-Pfad hasht das Live-Objekt (before/after), der Verify-
// UND der Offline-Archiv-Pfad hashen den jsonb-Roundtrip. Für nicht-JSON-native
// Werte (Prisma.Decimal, Buffer) und falsy-Werte (0/''/false) drifteten diese
// Formen — der Verifier hätte „Event-Body manipuliert" gemeldet, obwohl nichts
// manipuliert war. Seit alle drei Pfade `eventHash` (chain.ts) nutzen, kann das
// nicht mehr passieren. Diese Tests sichern genau diese Invariante ab.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { eventHash, chainValue, type ChainEvent } from '../chain';

const PREV = Buffer.alloc(32, 7);

function ev(before: unknown, after: unknown): ChainEvent {
  return {
    tenantId: '00000000-0000-0000-0000-000000000001',
    occurredAt: new Date('2026-01-02T03:04:05.678Z'),
    actorType: 'STAFF',
    actorId: '00000000-0000-0000-0000-0000000000aa',
    action: 'test.action',
    resourceType: 'thing',
    resourceId: 'rid-1',
    before,
    after,
  };
}

// Simuliert, was Postgres-jsonb mit einem Wert macht: speichern + zurücklesen.
// null bleibt null; alles andere geht durch den JSON-Roundtrip.
function jsonbRoundtrip(v: unknown): unknown {
  return v === undefined || v === null ? null : JSON.parse(JSON.stringify(v));
}

describe('chainValue — F1-Normalisierung', () => {
  it('undefined → null, null bleibt null', () => {
    expect(chainValue(undefined)).toBeNull();
    expect(chainValue(null)).toBeNull();
  });

  it('falsy-Werte bleiben erhalten (nicht zu null verschluckt)', () => {
    expect(chainValue(0)).toBe(0);
    expect(chainValue('')).toBe('');
    expect(chainValue(false)).toBe(false);
  });

  it('Buffer → JSON-Form {type:"Buffer",data:[…]} (NICHT hex:)', () => {
    expect(chainValue(Buffer.from('abc'))).toEqual({ type: 'Buffer', data: [97, 98, 99] });
  });

  it('Decimal-like (toJSON liefert String) → String', () => {
    expect(chainValue({ toJSON: () => '19.90' })).toBe('19.90');
  });

  it('RF-10: BigInt → String (wirft nicht, auch verschachtelt)', () => {
    // Nacktes JSON.stringify würde bei BigInt einen TypeError werfen und die
    // umgebende Fach-TX zurückrollen (z. B. sizeBytes aus BigInt-Spalten).
    expect(chainValue(123n)).toBe('123');
    expect(chainValue({ sizeBytes: 9007199254740993n })).toEqual({ sizeBytes: '9007199254740993' });
    expect(chainValue([1n, { n: 2n }])).toEqual(['1', { n: '2' }]);
  });
});

describe('eventHash — Record == Verify == Archiv (F1/A2)', () => {
  // Die entscheidende Invariante: ob before/after als LIVE-Wert (Record) ODER als
  // jsonb-Roundtrip (Verify/Archiv) hereinkommt, der Hash ist identisch. Bricht,
  // sobald eventHash aufhört zu normalisieren (Regress auf Live-Objekt-Hashen).
  const cases: Array<{ name: string; before: unknown; after: unknown }> = [
    { name: 'falsy 0', before: 0, after: 0 },
    { name: "falsy ''", before: '', after: 1 },
    { name: 'falsy false', before: false, after: { ok: false } },
    { name: 'Buffer', before: Buffer.from('abc'), after: null },
    { name: 'Decimal-like', before: { toJSON: () => '19.90' }, after: null },
    { name: 'verschachtelt', before: { b: 2, a: [3, { z: 1 }] }, after: { x: 1 } },
    { name: 'undefined', before: undefined, after: undefined },
    { name: 'gemischt', before: { betrag: { toJSON: () => '0.00' }, n: 0 }, after: false },
  ];

  for (const c of cases) {
    it(`${c.name}: Live-Wert hasht wie jsonb-Roundtrip`, () => {
      const recordHash = eventHash(PREV, ev(c.before, c.after));
      const verifyHash = eventHash(PREV, ev(jsonbRoundtrip(c.before), jsonbRoundtrip(c.after)));
      expect(recordHash.equals(verifyHash)).toBe(true);
    });
  }

  it('RF-10: BigInt-Live-Wert hasht wie der gespeicherte jsonb-Roundtrip (String)', () => {
    // Record speichert chainValue(before) als jsonb → BigInt landet als String
    // in der DB; der Verify-Pfad liest genau diesen String zurück.
    const recordHash = eventHash(PREV, ev({ sizeBytes: 123n }, null));
    const verifyHash = eventHash(PREV, ev({ sizeBytes: '123' }, null));
    expect(recordHash.equals(verifyHash)).toBe(true);
  });

  it('Date- und String-occurredAt liefern denselben Hash', () => {
    const d = new Date('2026-01-02T03:04:05.678Z');
    const a = eventHash(PREV, { ...ev(null, null), occurredAt: d });
    const b = eventHash(PREV, { ...ev(null, null), occurredAt: d.toISOString() });
    expect(a.equals(b)).toBe(true);
  });

  it('bindet den occurredAt-Zeitpunkt gegen nachträgliche Änderung in den Hash', () => {
    const a = eventHash(PREV, {
      ...ev(null, null),
      occurredAt: new Date('2026-01-02T03:04:05.678Z'),
    });
    const b = eventHash(PREV, {
      ...ev(null, null),
      occurredAt: new Date('2026-01-02T03:04:05.679Z'),
    });
    expect(a.equals(b)).toBe(false);
  });

  it('unterschiedliche before-Werte ⇒ unterschiedliche Hashes (Manipulation erkannt)', () => {
    const a = eventHash(PREV, ev({ x: 1 }, null));
    const b = eventHash(PREV, ev({ x: 2 }, null));
    expect(a.equals(b)).toBe(false);
  });
});
