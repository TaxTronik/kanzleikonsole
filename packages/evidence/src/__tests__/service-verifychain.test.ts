// =============================================================================
// verifyChain — Bindung an die REKONSTRUIERTE Kette + Adapter-Policy.
//
// Das hier ist das Abnahmeprotokoll für den wichtigsten Review-Punkt: der TSA-
// Stempel wird gegen den AUS DER SHA-256-KETTE rekonstruierten Spitzen-Hash
// geprüft, NIE gegen die gespeicherte Spalte `audit_seal.top_hash`. Sonst
// validierte man DB gegen DB — und genau das war der Angriff.
//
// Kein echter Postgres: ein Fake-`tx` liefert handgebaute, konsistente Audit-
// Rows + Seals; ein Stub-TimestampPort simuliert eine TSA, die an einen ganz
// bestimmten Payload gebunden ist (verify = sha256(payload) === blob).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { EvidenceService } from '../service';
import { eventHash } from '../chain';
import { anchorGenesisHash, anchorPayload, anchorTokenHash } from '../anchor';
import {
  LocalTimestampAdapter,
  type TimestampPort,
  type TimestampResult,
} from '../ports/timestamp';

// ----- Helpers ---------------------------------------------------------------

/** Repliziert EvidenceService.genesisHash (privat) für den Testaufbau. */
function genesis(tenantId: string): Buffer {
  return createHash('sha256')
    .update(Buffer.from('taxtronik-genesis:', 'utf8'))
    .update(Buffer.from(tenantId, 'utf8'))
    .digest();
}

function sha256(b: Uint8Array | string): Buffer {
  return createHash('sha256').update(b).digest();
}

interface AuditRow {
  id: bigint;
  occurred_at: Date;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before: unknown;
  after: unknown;
  prev_hash: Buffer;
  this_hash: Buffer;
}

interface SealRow {
  seal_date: Date;
  top_audit_id: bigint;
  top_hash: Buffer;
  tsa_response_blob: Buffer | null;
}

interface AnchorRow {
  id: bigint;
  from_audit_id: bigint;
  top_audit_id: bigint;
  top_hash: Buffer;
  previous_anchor_hash: Buffer;
  anchor_hash: Buffer;
  tsa_response_blob: Buffer;
}

/** Baut eine in sich konsistente Hash-Kette aus n Events; gibt Rows + Top-Hash. */
function buildChain(tenantId: string, n: number): { rows: AuditRow[]; top: Buffer } {
  const rows: AuditRow[] = [];
  let prev = genesis(tenantId);
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const occurredAt = new Date(base + i * 1000);
    const after = { seq: i };
    const thisHash = eventHash(prev, {
      tenantId,
      occurredAt,
      actorType: 'STAFF',
      actorId: null,
      action: 'test.evt',
      resourceType: 'test',
      resourceId: null,
      before: null,
      after,
    });
    rows.push({
      id: BigInt(i + 1),
      occurred_at: occurredAt,
      actor_type: 'STAFF',
      actor_id: null,
      action: 'test.evt',
      resource_type: 'test',
      resource_id: null,
      before: null,
      after,
      prev_hash: prev,
      this_hash: thisHash,
    });
    prev = thisHash;
  }
  return { rows, top: prev };
}

/** Fake-tx: dispatcht $queryRaw nach Tabellenname im SQL-Template. */
function makeTx(rows: AuditRow[], seals: SealRow[], anchors: AnchorRow[] = []) {
  const tx = {
    $queryRaw: (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('audit_seal')) return Promise.resolve(seals);
      if (sql.includes('audit_anchor')) return Promise.resolve(anchors);
      if (sql.includes('audit_log')) return Promise.resolve(rows);
      return Promise.reject(new Error('unerwartete Query: ' + sql));
    },
    $queryRawUnsafe: () => Promise.resolve([]),
    $executeRaw: () => Promise.resolve(0),
  };
  return tx as unknown as Parameters<EvidenceService['verifyChain']>[0];
}

/** Stub-TSA: gebunden an genau einen Payload (verify = sha256(payload) === blob). */
class StubTsa implements TimestampPort {
  readonly mode = 'rfc3161' as const;
  async timestamp(): Promise<TimestampResult> {
    throw new Error('timestamp im Test nicht genutzt');
  }
  async verify(payload: Uint8Array, response: Uint8Array | null): Promise<boolean> {
    if (!response) return false;
    return sha256(payload).equals(Buffer.from(response));
  }
}

const reason0 = (r: { sealBreaks: Array<{ reason: string }> }) => r.sealBreaks[0]?.reason ?? '';

// ----- Fall 1: Bindung an die rekonstruierte Kette ---------------------------

describe('verifyChain — Bindung an die rekonstruierte Kette (Review Punkt 2)', () => {
  it('honest: Token bindet an den rekonstruierten Top-Hash → ok', async () => {
    const t = 'tenant-a';
    const { rows, top } = buildChain(t, 3);
    const seals: SealRow[] = [
      {
        seal_date: new Date(Date.UTC(2026, 0, 1)),
        top_audit_id: 3n,
        top_hash: top,
        tsa_response_blob: sha256(top),
      },
    ];
    const r = await new EvidenceService(new StubTsa()).verifyChain(makeTx(rows, seals), t);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(3);
    expect(r.sealsChecked).toBe(1);
    expect(r.sealBreaks).toHaveLength(0);
  });

  it('DB-Angriff: History konsistent umgeschrieben + Spalte angepasst, Token bindet an Original → FAIL', async () => {
    // Die Rows sind eine in sich konsistente (umgeschriebene) Kette → Schritt 1
    // (Ketten-Walk) findet KEINEN Bruch. Die Spalte top_hash wurde vom Angreifer
    // an die neue Kette angepasst → die Spalten-Integritätsprüfung greift NICHT.
    // NUR die Token-Bindung an den rekonstruierten Hash fängt den Angriff: der
    // unveränderliche TSA-Stempel trägt noch den Imprint des Original-Tops.
    const t = 'tenant-b';
    const { rows, top: topNew } = buildChain(t, 3);
    const originalTop = sha256('vor-der-umschreibung-versiegelter-top');
    const seals: SealRow[] = [
      {
        seal_date: new Date(Date.UTC(2026, 0, 2)),
        top_audit_id: 3n,
        top_hash: topNew, // Angreifer hat die Spalte mit-angepasst
        tsa_response_blob: sha256(originalTop), // Token bindet an den ORIGINAL-Top
      },
    ];
    const r = await new EvidenceService(new StubTsa()).verifyChain(makeTx(rows, seals), t);
    expect(r.ok).toBe(false);
    expect(reason0(r)).toMatch(/rekonstruierten Ketten-Spitzen-Hash/);
  });

  it('DB-Angriff (lokaler Adapter): Spalte veraltet → Spalten-Integrität fängt es OHNE Krypto', async () => {
    // verify() des LocalTimestampAdapter gibt IMMER true zurück. Trotzdem muss die
    // Manipulation auffallen — über den Abgleich rekonstruierter Hash vs. Spalte.
    const t = 'tenant-c';
    const { rows } = buildChain(t, 3);
    const staleColumn = sha256('alter-top-vor-umschreibung');
    const seals: SealRow[] = [
      {
        seal_date: new Date(Date.UTC(2026, 0, 3)),
        top_audit_id: 3n,
        top_hash: staleColumn,
        tsa_response_blob: null,
      },
    ];
    const r = await new EvidenceService(new LocalTimestampAdapter()).verifyChain(
      makeTx(rows, seals),
      t,
    );
    expect(r.ok).toBe(false);
    expect(reason0(r)).toMatch(/top_hash weicht vom rekonstruierten/);
  });

  it('Seal zeigt auf nicht (mehr) existente audit_id → FAIL', async () => {
    const t = 'tenant-d';
    const { rows, top } = buildChain(t, 2);
    const seals: SealRow[] = [
      {
        seal_date: new Date(Date.UTC(2026, 0, 4)),
        top_audit_id: 999n,
        top_hash: top,
        tsa_response_blob: sha256(top),
      },
    ];
    const r = await new EvidenceService(new StubTsa()).verifyChain(makeTx(rows, seals), t);
    expect(r.ok).toBe(false);
    expect(reason0(r)).toMatch(/fehlt in der rekonstruierten Kette/);
  });

  it('Event-Body manipuliert (Kette inkonsistent) → firstBreak im Walk', async () => {
    const t = 'tenant-e';
    const { rows } = buildChain(t, 3);
    // this_hash der mittleren Zeile kippen → Walk erkennt den Bruch.
    rows[1]!.this_hash = sha256('manipuliert');
    const r = await new EvidenceService(new StubTsa()).verifyChain(makeTx(rows, []), t);
    expect(r.ok).toBe(false);
    expect(r.firstBreak?.auditId).toBe(2n);
  });
});

describe('verifyChain — gekoppelte externe Anchor-Kette', () => {
  function buildAnchors(tenantId: string, rows: AuditRow[]): AnchorRow[] {
    const firstPayload = anchorPayload({
      tenantId,
      fromAuditId: 1n,
      topAuditId: 2n,
      topHash: rows[1]!.this_hash,
      previousAnchorHash: anchorGenesisHash(tenantId),
    });
    const firstResponse = sha256(firstPayload);
    const firstHash = anchorTokenHash(firstResponse);
    const secondPayload = anchorPayload({
      tenantId,
      fromAuditId: 3n,
      topAuditId: 3n,
      topHash: rows[2]!.this_hash,
      previousAnchorHash: firstHash,
    });
    const secondResponse = sha256(secondPayload);
    return [
      {
        id: 1n,
        from_audit_id: 1n,
        top_audit_id: 2n,
        top_hash: rows[1]!.this_hash,
        previous_anchor_hash: anchorGenesisHash(tenantId),
        anchor_hash: firstHash,
        tsa_response_blob: firstResponse,
      },
      {
        id: 2n,
        from_audit_id: 3n,
        top_audit_id: 3n,
        top_hash: rows[2]!.this_hash,
        previous_anchor_hash: firstHash,
        anchor_hash: anchorTokenHash(secondResponse),
        tsa_response_blob: secondResponse,
      },
    ];
  }

  it('prüft lokale Kettenspitzen und externe Vorgängerverkettung gemeinsam', async () => {
    const tenantId = 'tenant-anchor';
    const { rows } = buildChain(tenantId, 3);
    const result = await new EvidenceService(new StubTsa()).verifyChain(
      makeTx(rows, [], buildAnchors(tenantId, rows)),
      tenantId,
    );

    expect(result.ok).toBe(true);
    expect(result.anchorsChecked).toBe(2);
    expect(result.anchorBreaks).toHaveLength(0);
    expect(result.lastAnchoredAuditId).toBe(3n);
    expect(result.unanchoredEntries).toBe(0);
  });

  it('erkennt eine unterbrochene externe Vorgängerkette', async () => {
    const tenantId = 'tenant-anchor-break';
    const { rows } = buildChain(tenantId, 3);
    const anchors = buildAnchors(tenantId, rows);
    anchors[1]!.previous_anchor_hash = sha256('falscher-vorgaenger');

    const result = await new EvidenceService(new StubTsa()).verifyChain(
      makeTx(rows, [], anchors),
      tenantId,
    );

    expect(result.ok).toBe(false);
    expect(result.anchorBreaks[0]?.reason).toMatch(/Vorgängerkette/);
  });
});

// ----- Fall 7: Adapter-Modus immer ausweisen + Dev-Adapter-in-Prod = FAIL ----

describe('verifyChain — Adapter-Modus & Produktiv-Guard (Review Fall 7)', () => {
  const t = 'tenant-mode';
  const fresh = () => {
    const { rows, top } = buildChain(t, 1);
    return { rows, top };
  };

  it('Modus wird IMMER ausgewiesen (local)', async () => {
    const { rows, top } = fresh();
    const seals: SealRow[] = [
      { seal_date: new Date(), top_audit_id: 1n, top_hash: top, tsa_response_blob: null },
    ];
    const r = await new EvidenceService(new LocalTimestampAdapter()).verifyChain(
      makeTx(rows, seals),
      t,
    );
    expect(r.tsaMode).toBe('local');
  });

  it('Self-Timestamp im Produktivmodus → harter FAIL + policyBreak', async () => {
    const { rows, top } = fresh();
    const seals: SealRow[] = [
      { seal_date: new Date(), top_audit_id: 1n, top_hash: top, tsa_response_blob: null },
    ];
    const r = await new EvidenceService(new LocalTimestampAdapter()).verifyChain(
      makeTx(rows, seals),
      t,
      {
        requireExternalTsa: true,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.tsaMode).toBe('local');
    expect(r.policyBreaks.join(' ')).toMatch(/Produktivmodus/);
  });

  it('Self-Timestamp im Dev-Modus (requireExternalTsa:false) → kein Policy-Fail', async () => {
    const { rows, top } = fresh();
    const seals: SealRow[] = [
      { seal_date: new Date(), top_audit_id: 1n, top_hash: top, tsa_response_blob: null },
    ];
    const r = await new EvidenceService(new LocalTimestampAdapter()).verifyChain(
      makeTx(rows, seals),
      t,
      {
        requireExternalTsa: false,
      },
    );
    expect(r.policyBreaks).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('externe TSA im Produktivmodus → kein Policy-Fail', async () => {
    const { rows, top } = fresh();
    const seals: SealRow[] = [
      { seal_date: new Date(), top_audit_id: 1n, top_hash: top, tsa_response_blob: sha256(top) },
    ];
    const r = await new EvidenceService(new StubTsa()).verifyChain(makeTx(rows, seals), t, {
      requireExternalTsa: true,
    });
    expect(r.tsaMode).toBe('rfc3161');
    expect(r.policyBreaks).toHaveLength(0);
    expect(r.ok).toBe(true);
  });
});
