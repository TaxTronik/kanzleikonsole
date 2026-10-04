// =============================================================================
// Property-Based Tests für kanonische JSON-Serialisierung und Hash-Chain.
//
// Die Hash-Chain ist das Fundament des GoBD-Revisionsschutzes. Wenn
// canonicalJson nicht deterministisch ist, bricht die Chain bei der
// Re-Verifikation — und der Beweis der Unveränderlichkeit ist wertlos.
//
// Properties:
//   C1: Determinismus (gleiche Eingabe → gleiche Ausgabe)
//   C2: Schlüsselreihenfolge irrelevant ({a:1,b:2} == {b:2,a:1})
//   C3: undefined wird ausgelassen, null bleibt erhalten
//   C4: Verschachtelung: alle Ebenen folgen denselben Regeln
//   J1: Roundtrip verlustfrei im JSON-Datenmodell (wie jsonb: -0 wird 0)
//   H1: eventHash ist deterministisch
//   H2: Verschiedene Events → verschiedene Hashes (keine Kollision)
// =============================================================================

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fc from 'fast-check';
import { canonicalJson } from '../canonical-json';
import { chainValue, eventHash, type ChainEvent } from '../chain';

// ---------------------------------------------------------------------------
// Arbitraries: Generatoren für Zufallsdaten, die fast-check nutzt.
// ---------------------------------------------------------------------------

/** Zufälliges JSON-kompatibles Objekt mit String-Keys. */
const jsonValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 20 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.double({ min: -100, max: 100, noNaN: true }),
  // fc.double liefert -0 nur gelegentlich; J1 soll den Fall in jedem Lauf sehen.
  fc.constant(-0),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ minLength: 1, maxLength: 10 })),
  fc.record({
    a: fc.string({ minLength: 1, maxLength: 10 }),
    b: fc.integer({ min: 0, max: 999 }),
    c: fc.boolean(),
  }),
);

/** Ein Objekt mit 2-5 String-Keys und zufälligen Werten — in zufälliger Reihenfolge. */
const shuffledObjectArb = fc
  .array(
    fc.tuple(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !s.includes('"')),
        fc.constantFrom('__proto__', 'constructor', 'toString'),
      ),
      jsonValueArb,
    ),
    {
      minLength: 2,
      maxLength: 5,
    },
  )
  .map((entries) => Object.fromEntries(entries));

/** Zufälliges ChainEvent mit eingeschränkten Werten (vermeidet fast-check-Edge-Cases). */
const chainEventArb: fc.Arbitrary<ChainEvent> = fc.record({
  tenantId: fc.uuid(),
  occurredAt: fc.integer({ min: 946684800000, max: 4102444800000 }).map((t) => new Date(t)),
  actorType: fc.constantFrom('STAFF', 'CLIENT_CONTACT', 'SYSTEM'),
  actorId: fc.oneof(fc.uuid(), fc.constant(null)),
  action: fc.stringMatching(/[a-z]{5,20}/),
  resourceType: fc.stringMatching(/[a-z_]{3,15}/),
  resourceId: fc.oneof(fc.uuid(), fc.constant(null)),
  before: fc.oneof(fc.constant(null), fc.record({ value: fc.integer({ min: 0, max: 999 }) })),
  after: fc.oneof(fc.constant(null), fc.record({ value: fc.integer({ min: 0, max: 999 }) })),
});

// ---------------------------------------------------------------------------
// Canonical-JSON Properties
// ---------------------------------------------------------------------------

describe('canonicalJson — Property-Based', () => {
  it('C1: Determinismus — gleiche Eingabe → gleiche Ausgabe', () => {
    fc.assert(
      fc.property(shuffledObjectArb, (obj) => {
        expect(canonicalJson(obj)).toBe(canonicalJson(obj));
      }),
    );
  });

  it('C2: Schlüsselreihenfolge irrelevant — {a:1,b:2} == {b:2,a:1}', () => {
    fc.assert(
      fc.property(shuffledObjectArb, (obj) => {
        // Rekonstruiere das Objekt in umgekehrter Key-Reihenfolge
        const reversedKeys = Object.keys(obj).reverse();
        const reversed = Object.fromEntries(reversedKeys.map((key) => [key, obj[key]]));
        expect(canonicalJson(obj)).toBe(canonicalJson(reversed));
      }),
    );
  });

  it('C3: undefined wird ausgelassen, null bleibt erhalten', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.string({ minLength: 1, maxLength: 10 }),
        (key1, key2) => {
          fc.pre(key1 !== key2);
          const withUndefined = { [key1]: 'value', [key2]: undefined };
          const withoutKey = { [key1]: 'value' };
          expect(canonicalJson(withUndefined)).toBe(canonicalJson(withoutKey));
        },
      ),
    );
  });

  it('C4: null wird serialisiert als "null" (nicht ausgelassen)', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson(null)).toBe('null');
  });

  it('AUDIT-HASH-CHAIN-001: behält alle eigenen JSON-Schlüssel und Werte', () => {
    fc.assert(
      fc.property(shuffledObjectArb, (obj) => {
        // J1: Maßstab ist das JSON-Datenmodell, in dem auch jsonb speichert. Es
        // kennt kein -0 (JSON.stringify(-0) === '0'); toEqual vergleicht Zahlen
        // aber per Object.is und wertete -0 gegenüber 0 sonst als Verlust.
        const persisted: unknown = JSON.parse(JSON.stringify(obj));
        expect(JSON.parse(canonicalJson(obj))).toEqual(persisted);
        expect(canonicalJson(persisted)).toBe(canonicalJson(obj));
      }),
    );
  });
});

describe('AUDIT-HASH-CHAIN-001: -0 im JSON-Datenmodell', () => {
  const previous = Buffer.alloc(32, 7);
  const event: ChainEvent = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    occurredAt: '2026-10-04T00:00:00.000Z',
    actorType: 'STAFF',
    actorId: null,
    action: 'invoice.update',
    resourceType: 'invoice',
    resourceId: null,
    before: null,
    after: null,
  };

  it('kanonisiert -0 und 0 auf allen Ebenen identisch als 0', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ a: -0, b: [-0, 0], c: { d: -0 } })).toBe(
      '{"a":0,"b":[0,0],"c":{"d":0}}',
    );
    expect(canonicalJson({ a: -0, b: [-0, 0], c: { d: -0 } })).toBe(
      canonicalJson({ a: 0, b: [0, 0], c: { d: 0 } }),
    );
  });

  it('hasht -0 vor der Speicherung wie den jsonb-Roundtrip bei der Prüfung', () => {
    const recorded = { ...event, after: { discount: -0, lines: [-0, 1.5] } };
    // Record speichert JSON.stringify(chainValue(after)); die Prüfung liest den
    // geparsten jsonb-Wert zurück.
    const stored: unknown = JSON.parse(JSON.stringify(chainValue(recorded.after)));
    expect(stored).toEqual({ discount: 0, lines: [0, 1.5] });
    expect(Object.is((stored as { discount: number }).discount, 0)).toBe(true);

    const atRecord = eventHash(previous, recorded);
    expect(atRecord.equals(eventHash(previous, { ...event, after: stored }))).toBe(true);
    expect(
      atRecord.equals(eventHash(previous, { ...event, after: { discount: 0, lines: [0, 1.5] } })),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hash-Chain Properties
// ---------------------------------------------------------------------------

describe('eventHash — Property-Based', () => {
  // Fester prevHash (wie im echten System ein SHA-256-Hex-String).
  // Nur das Event wird von fast-check variiert.
  const FIXED_PREV_HASH = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  it('H1: Determinismus — gleiche Eingabe → gleicher Hash', () => {
    fc.assert(
      fc.property(chainEventArb, (event) => {
        const h1 = eventHash(FIXED_PREV_HASH, event);
        const h2 = eventHash(FIXED_PREV_HASH, event);
        expect(h1.equals(h2)).toBe(true);
      }),
    );
  });

  it('H2: Unterschiedlicher action → unterschiedlicher Hash', () => {
    fc.assert(
      fc.property(chainEventArb, fc.stringMatching(/[a-z]{5,20}/), (baseEvent, otherAction) => {
        fc.pre(otherAction !== baseEvent.action);
        const hashA = eventHash(FIXED_PREV_HASH, baseEvent);
        const hashB = eventHash(FIXED_PREV_HASH, { ...baseEvent, action: otherAction });
        expect(hashA.equals(hashB)).toBe(false);
      }),
    );
  });

  it('H3: Verschiedener prevHash → verschiedener Event-Hash (Chain-Integrität)', () => {
    // Statt fast-check: deterministischer Test mit 50 zufälligen Hex-Strings.
    // Die Chain-Integrität ist eine fundamentale Eigenschaft von SHA-256 und
    // wird zusätzlich in chain.test.ts und hash-chain.test.ts geprüft.
    for (let i = 0; i < 50; i++) {
      const prevA = Array.from(crypto.randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join(
        '',
      );
      let prevB: string;
      do {
        prevB = Array.from(crypto.randomBytes(32), (b) => b.toString(16).padStart(2, '0')).join('');
      } while (prevB === prevA);

      const event: ChainEvent = {
        tenantId: `tenant-${i}`,
        occurredAt: new Date('2025-06-15T12:00:00.000Z'),
        actorType: 'STAFF',
        actorId: `actor-${i}`,
        action: `action.${i}`,
        resourceType: 'test_resource',
        resourceId: `resource-${i}`,
        before: null,
        after: { value: i },
      };

      const hashA = eventHash(prevA, event);
      const hashB = eventHash(prevB, event);
      expect(hashA.equals(hashB)).toBe(false);
    }
  });
});
