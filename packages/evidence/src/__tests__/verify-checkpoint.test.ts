// Fachkatalog: AUDIT-VERIFY-ALERT-001
// P-04: Die Vollprüfung muss den eingefrorenen Prüf-Checkpoint exakt bestätigen.
// Ergänzt die PostgreSQL-Suite (verify-checkpoint-db.test.ts) um den reinen
// Feldvergleich, den dort die vorgelagerte Integritätsprüfung bereits abdeckt,
// und um die reihenfolgeunabhängige Befundliste (Review R5).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { genesisCursor, type ChainCursor, type SegmentSealBreak } from '../service';
import {
  MAX_STORED_FINDINGS,
  cursorMismatch,
  emptyFindings,
  mergeFindings,
  type CheckpointFindings,
} from '../verify-checkpoint';

const TENANT = '00000000-0000-4000-8000-0000000000c1';

function cursor(overrides: Partial<ChainCursor> = {}): ChainCursor {
  return {
    ...genesisCursor(TENANT, 4n),
    auditId: 120n,
    auditHash: createHash('sha256').update('spitze').digest(),
    auditCount: 40,
    sealsChecked: 3,
    sealsTrustAnchored: 3,
    anchorId: 9n,
    anchorHash: createHash('sha256').update('anker').digest(),
    anchorTopAuditId: 118n,
    anchorsChecked: 5,
    anchorsTrustAnchored: 5,
    ...overrides,
  };
}

describe('cursorMismatch', () => {
  it('akzeptiert einen identischen Stand; prüfergebnisabhängige Felder sind keine Position', () => {
    expect(cursorMismatch(cursor(), cursor())).toBeNull();
    // Trust-Zähler und der zuletzt GÜLTIGE Anker hängen vom Prüfergebnis ab
    // (Trust-Store, Ankerbefunde) und sind kein Manipulationsbefund der Position.
    expect(
      cursorMismatch(
        cursor({
          sealsTrustAnchored: 1,
          anchorsTrustAnchored: 0,
          anchorHash: Buffer.alloc(32, 2),
          anchorTopAuditId: 117n,
        }),
        cursor(),
      ),
    ).toBeNull();
  });

  it.each([
    [{ auditId: 121n }, 'Audit-ID 121 statt 120'],
    [{ auditHash: Buffer.alloc(32, 1) }, 'Ketten-Hash an Audit-ID 120 weicht ab'],
    [{ auditCount: 39 }, '39 statt 40 Audit-Einträge'],
    [{ sealsChecked: 2 }, '2 statt 3 Tagesversiegelungen'],
    [{ anchorId: 8n }, 'externe Ankerkette endet bei Anker 8 statt 9'],
    [{ anchorsChecked: 4 }, '4 statt 5 Rolling-Anker'],
  ] as Array<[Partial<ChainCursor>, string]>)('meldet %o', (change, expected) => {
    expect(cursorMismatch(cursor(change), cursor())).toBe(expected);
  });

  it('startet die Vollprüfung bei Genesis mit fester Siegelgrenze', () => {
    const start = genesisCursor(TENANT, 17n);
    expect(start).toMatchObject({
      auditId: 0n,
      auditCount: 0,
      sealId: 17n,
      sealsChecked: 0,
      sealsTrustAnchored: null,
      anchorId: 0n,
      anchorTopAuditId: 0n,
      anchorsChecked: 0,
    });
    expect(start.auditHash).toHaveLength(32);
    expect(start.anchorHash.equals(start.auditHash)).toBe(false);
  });
});

describe('mergeFindings', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // 1.500 Siegelbefunde; IDs absteigend zum Datum wie bei nachträglich
  // angelegten Siegeln mit früherem Datum.
  const breaks: SegmentSealBreak[] = Array.from({ length: 1_500 }, (_, i) => ({
    sealId: BigInt(10_000 - i * 3),
    sealDate: new Date(Date.UTC(2000, 0, 1) + i * DAY),
    topAuditId: 7n,
    reason: `Befund ${i}`,
  }));

  function mergeAll(chunks: SegmentSealBreak[][]): CheckpointFindings {
    let findings = emptyFindings();
    for (const chunk of chunks) {
      findings = mergeFindings(findings, { sealBreaks: chunk, anchorBreaks: [] });
    }
    return findings;
  }

  it('speichert unabhängig von der Verarbeitungsreihenfolge dieselben Befunde', () => {
    const inOrder = mergeAll([breaks]);
    const shuffled = mergeAll([
      breaks.slice(900).reverse(),
      breaks.slice(0, 450),
      breaks.slice(450, 900).reverse(),
    ]);
    expect(shuffled).toEqual(inOrder);
    expect(inOrder.omittedSeals).toBe(500);
    // Gespeichert bleiben die Befunde mit den niedrigsten IDs, aufsteigend.
    const lowest = breaks
      .map((b) => b.sealId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_STORED_FINDINGS)
      .map(String);
    expect(inOrder.seals.map((seal) => seal.id)).toEqual(lowest);
  });

  it('ersetzt einen Befund derselben ID, statt ihn doppelt zu zählen', () => {
    const first = mergeAll([breaks.slice(0, 2)]);
    const again = mergeFindings(first, {
      sealBreaks: [{ ...breaks[0]!, reason: 'neu bewertet' }],
      anchorBreaks: [],
    });
    expect(again.seals).toHaveLength(2);
    expect(again.omittedSeals).toBe(0);
    expect(again.seals.find((seal) => seal.id === String(breaks[0]!.sealId))?.reason).toBe(
      'neu bewertet',
    );
  });
});
