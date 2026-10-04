// Fachkatalog: AUDIT-HASH-CHAIN-001, AUDIT-VERIFY-ALERT-001
// =============================================================================
// R-15: verifyChain und verifyRecoverySegment teilen Ketten-Walker und
// Siegelprüfung. Diese Tests pinnen das gemeinsame Verhalten, das vorher in
// zwei Kopien lag: cursor-basierter Walk über mehrere 1000er-Chunks, identische
// Brucherkennung (Vorgänger-Link und Ereignis-Hash), Abbruch vor der
// Siegelprüfung, Siegelprüfung gegen den REKONSTRUIERTEN Hash mit
// kontextabhängigen Begründungen sowie der bewusst unveränderte Prüfumfang der
// Recovery-Teilkette (keine Rolling-Anker, keine Unanchored-Policy).
//
// Der Fake-`tx` wertet die Parameter der Batch-Abfrage aus (Cursor + LIMIT),
// damit der Mehr-Chunk-Pfad wirklich durchlaufen wird.
// =============================================================================

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EvidenceService } from '../service';
import { eventHash } from '../chain';
import { anchorGenesisHash, anchorPayload, anchorTokenHash } from '../anchor';
import type { TimestampPort, TimestampResult } from '../ports/timestamp';

const TENANT = '00000000-0000-4000-8000-0000000000a1';

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

function sha256(b: Uint8Array | string): Buffer {
  return createHash('sha256').update(b).digest();
}

function genesis(tenantId: string): Buffer {
  return createHash('sha256')
    .update(Buffer.from('taxtronik-genesis:', 'utf8'))
    .update(Buffer.from(tenantId, 'utf8'))
    .digest();
}

/** Konsistente Kette mit lückenhaften IDs (andere Tenants teilen die Sequenz). */
function buildChain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = genesis(TENANT);
  const base = Date.UTC(2026, 3, 1);
  for (let i = 0; i < n; i++) {
    const occurredAt = new Date(base + i * 1000);
    const after = { seq: i, nested: { flag: i % 2 === 0 } };
    const thisHash = eventHash(prev, {
      tenantId: TENANT,
      occurredAt,
      actorType: 'SYSTEM',
      actorId: null,
      action: 'test.walk',
      resourceType: 'test',
      resourceId: String(i),
      before: null,
      after,
    });
    rows.push({
      id: BigInt(i * 3 + 7),
      occurred_at: occurredAt,
      actor_type: 'SYSTEM',
      actor_id: null,
      action: 'test.walk',
      resource_type: 'test',
      resource_id: String(i),
      before: null,
      after,
      prev_hash: prev,
      this_hash: thisHash,
    });
    prev = thisHash;
  }
  return rows;
}

function idAt(rows: AuditRow[], index: number): bigint {
  return rows[index]!.id;
}

/**
 * Fake-tx: Batch-Abfrage respektiert `id > cursor` und LIMIT, die Checkpoint-
 * Abfrage `id = X`, die Recovery-Siegelabfrage `top_audit_id >= X`.
 */
function makeTx(rows: AuditRow[], seals: SealRow[], anchors: unknown[] = []) {
  const batchCalls: bigint[] = [];
  const tx = {
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM audit_seal')) {
        if (sql.includes('top_audit_id >=')) {
          const min = values[1] as bigint;
          return Promise.resolve(seals.filter((s) => s.top_audit_id >= min));
        }
        return Promise.resolve(seals);
      }
      if (sql.includes('FROM audit_anchor')) return Promise.resolve(anchors);
      if (sql.includes('FROM audit_log') && sql.includes('id > ?')) {
        const cursor = values[1] as bigint;
        const limit = Number(values[2]);
        batchCalls.push(cursor);
        return Promise.resolve(rows.filter((r) => r.id > cursor).slice(0, limit));
      }
      if (sql.includes('FROM audit_log') && sql.includes('id = ?')) {
        const id = values[1] as bigint;
        return Promise.resolve(rows.filter((r) => r.id === id).slice(0, 1));
      }
      return Promise.reject(new Error('unerwartete Query: ' + sql));
    },
    $queryRawUnsafe: () => Promise.resolve([]),
    $executeRaw: () => Promise.resolve(0),
  };
  return { tx: tx as unknown as Parameters<EvidenceService['verifyChain']>[0], batchCalls };
}

/** TSA-Stub: Token = sha256(Payload); meldet Trust-Verankerung (verifyDetailed). */
class BindingTsa implements TimestampPort {
  readonly mode = 'rfc3161' as const;
  async timestamp(): Promise<TimestampResult> {
    throw new Error('timestamp im Test nicht genutzt');
  }
  async verify(payload: Uint8Array, response: Uint8Array | null): Promise<boolean> {
    return !!response && sha256(payload).equals(Buffer.from(response));
  }
  async verifyDetailed(payload: Uint8Array, response: Uint8Array | null) {
    const ok = await this.verify(payload, response);
    return { ok, trustAnchored: ok };
  }
}

function sealFor(row: AuditRow, day: number): SealRow {
  return {
    seal_date: new Date(Date.UTC(2026, 3, day)),
    top_audit_id: row.id,
    top_hash: row.this_hash,
    tsa_response_blob: sha256(row.this_hash),
  };
}

const service = new EvidenceService(new BindingTsa());

describe('R-15: gemeinsamer Ketten-Walker', () => {
  it('prüft beide Einstiege cursor-basiert über mehrere 1000er-Chunks', async () => {
    const rows = buildChain(2_501);
    const full = makeTx(rows, []);
    const recoveryStart = idAt(rows, 1_000);
    const segment = makeTx(rows, []);

    const chain = await service.verifyChain(full.tx, TENANT);
    const recovery = await service.verifyRecoverySegment(segment.tx, TENANT, recoveryStart);

    expect(chain).toMatchObject({ ok: true, checked: 2_501, lastAuditId: idAt(rows, 2_500) });
    expect(recovery).toMatchObject({ ok: true, checked: 1_501, lastAuditId: idAt(rows, 2_500) });
    // Drei volle Chunks plus Abschluss: Cursor ist jeweils die letzte ID des Vorchunks.
    expect(full.batchCalls).toEqual([-1n, idAt(rows, 999), idAt(rows, 1_999)]);
    expect(segment.batchCalls).toEqual([recoveryStart - 1n, idAt(rows, 1_999)]);
  });

  it('meldet einen Ereignis-Hash-Bruch in beiden Einstiegen identisch', async () => {
    const rows = buildChain(1_200);
    rows[1_100]!.after = { seq: 'manipuliert' };

    const chain = await service.verifyChain(makeTx(rows, []).tx, TENANT);
    const recovery = await service.verifyRecoverySegment(
      makeTx(rows, []).tx,
      TENANT,
      idAt(rows, 1_050),
    );

    expect(chain.ok).toBe(false);
    expect(chain.firstBreak).toMatchObject({
      auditId: idAt(rows, 1_100),
      actualHash: rows[1_100]!.this_hash.toString('hex'),
    });
    expect(chain.firstBreak?.expectedHash).not.toBe(chain.firstBreak?.actualHash);
    expect(recovery.firstBreak).toEqual(chain.firstBreak);
    // Abbruch VOR Siegel- und Ankerprüfung; checked/lastAuditId = letzte intakte Zeile.
    expect(chain).toMatchObject({ checked: 1_100, lastAuditId: idAt(rows, 1_099) });
    expect(recovery).toMatchObject({ checked: 50, lastAuditId: idAt(rows, 1_099) });
  });

  it('meldet einen Vorgänger-Link-Bruch mit erwartetem und gefundenem prev_hash', async () => {
    const rows = buildChain(30);
    const forged = sha256('fremder-vorgaenger');
    rows[20]!.prev_hash = forged;

    const chain = await service.verifyChain(makeTx(rows, []).tx, TENANT);
    const recovery = await service.verifyRecoverySegment(
      makeTx(rows, []).tx,
      TENANT,
      idAt(rows, 10),
    );

    const expected = {
      auditId: idAt(rows, 20),
      occurredAt: rows[20]!.occurred_at,
      expectedHash: rows[19]!.this_hash.toString('hex'),
      actualHash: forged.toString('hex'),
    };
    expect(chain.firstBreak).toEqual(expected);
    expect(recovery.firstBreak).toEqual(expected);
  });

  it('bricht vor der Siegelprüfung ab, wenn der Walk einen Bruch findet', async () => {
    const rows = buildChain(5);
    const seals = [sealFor(rows[4]!, 1)];
    rows[2]!.this_hash = sha256('manipuliert');

    const chain = await service.verifyChain(makeTx(rows, seals).tx, TENANT);
    const recovery = await service.verifyRecoverySegment(
      makeTx(rows, seals).tx,
      TENANT,
      idAt(rows, 1),
    );

    for (const result of [chain, recovery]) {
      expect(result.firstBreak?.auditId).toBe(idAt(rows, 2));
      expect(result.sealsChecked).toBe(0);
      expect(result.sealBreaks).toEqual([]);
      expect(result.sealsTrustAnchored).toBeUndefined();
    }
  });
});

describe('R-15: gemeinsame Siegelprüfung gegen den rekonstruierten Hash', () => {
  it('zählt gültige und trust-verankerte Siegel in beiden Einstiegen gleich', async () => {
    const rows = buildChain(12);
    const seals = [sealFor(rows[5]!, 1), sealFor(rows[11]!, 2)];

    const chain = await service.verifyChain(makeTx(rows, seals).tx, TENANT);
    const recovery = await service.verifyRecoverySegment(
      makeTx(rows, seals).tx,
      TENANT,
      idAt(rows, 3),
    );

    for (const result of [chain, recovery]) {
      expect(result).toMatchObject({ ok: true, sealsChecked: 2, sealsTrustAnchored: 2 });
      expect(result.sealBreaks).toEqual([]);
    }
  });

  it('verwendet je Kontext eigene Begründungen bei identischer Prüflogik', async () => {
    const rows = buildChain(12);
    const missing = { ...sealFor(rows[11]!, 1), top_audit_id: 9_999n };
    const staleColumn = { ...sealFor(rows[8]!, 2), top_hash: sha256('alte-spalte') };
    const wrongToken = { ...sealFor(rows[10]!, 3), tsa_response_blob: sha256('fremd') };
    const seals = [missing, staleColumn, wrongToken];

    const chain = await service.verifyChain(makeTx(rows, seals).tx, TENANT);
    const recovery = await service.verifyRecoverySegment(
      makeTx(rows, seals).tx,
      TENANT,
      idAt(rows, 4),
    );

    expect(chain.sealBreaks.map((b) => b.reason)).toEqual([
      'versiegelter Spitzen-Eintrag (audit_id 9999) fehlt in der rekonstruierten Kette',
      'gespeicherter top_hash weicht vom rekonstruierten Ketten-Hash ab (DB-Manipulationsverdacht)',
      'TSA-Verifikation gegen rekonstruierten Ketten-Spitzen-Hash fehlgeschlagen',
    ]);
    expect(recovery.sealBreaks.map((b) => b.reason)).toEqual([
      'versiegelter Spitzen-Eintrag (audit_id 9999) fehlt in der Recovery-Teilkette',
      'gespeicherter top_hash weicht vom rekonstruierten Recovery-Ketten-Hash ab',
      'TSA-Verifikation gegen Recovery-Ketten-Spitzen-Hash fehlgeschlagen',
    ]);
    for (const result of [chain, recovery]) {
      expect(result.ok).toBe(false);
      expect(result.sealsChecked).toBe(3);
      // Nur das Siegel, das bis zur TSA-Prüfung kommt, liefert eine Verankerungsauskunft.
      expect(result.sealsTrustAnchored).toBe(0);
      expect(result.sealBreaks.map((b) => b.sealDate)).toEqual(seals.map((s) => s.seal_date));
    }
  });
});

describe('R-15: unveränderter Prüfumfang der Recovery-Teilkette', () => {
  function anchorOver(rows: AuditRow[]) {
    const top = rows.at(-1)!;
    const response = sha256(
      anchorPayload({
        tenantId: TENANT,
        fromAuditId: rows[0]!.id,
        topAuditId: top.id,
        topHash: top.this_hash,
        previousAnchorHash: anchorGenesisHash(TENANT),
      }),
    );
    return {
      id: 1n,
      from_audit_id: rows[0]!.id,
      top_audit_id: top.id,
      top_hash: top.this_hash,
      previous_anchor_hash: anchorGenesisHash(TENANT),
      anchor_hash: anchorTokenHash(response),
      tsa_response_blob: response,
    };
  }

  it('prüft Rolling-Anker nur in verifyChain, nicht in der Recovery-Teilkette', async () => {
    const rows = buildChain(6);
    const anchors = [anchorOver(rows)];

    const chain = await service.verifyChain(makeTx(rows, [], anchors).tx, TENANT);
    const recovery = await service.verifyRecoverySegment(
      makeTx(rows, [], anchors).tx,
      TENANT,
      idAt(rows, 2),
    );

    expect(chain).toMatchObject({ ok: true, anchorsChecked: 1, anchorsTrustAnchored: 1 });
    expect(chain.lastAnchorId).toBe(1n);
    expect(recovery).toMatchObject({
      ok: true,
      anchorsChecked: 0,
      anchorsTrustAnchored: 0,
      lastAnchorId: null,
      lastAnchoredAuditId: null,
      unanchoredEntries: 0,
      oldestUnanchoredAt: null,
    });
  });

  it('wendet maxUnanchoredAgeMs nur in verifyChain an', async () => {
    const rows = buildChain(3);
    const opts = { maxUnanchoredAgeMs: 1_000 };

    const chain = await service.verifyChain(makeTx(rows, []).tx, TENANT, opts);
    const recovery = await service.verifyRecoverySegment(
      makeTx(rows, []).tx,
      TENANT,
      idAt(rows, 0),
      opts,
    );

    expect(chain.ok).toBe(false);
    expect(chain.unanchoredEntries).toBe(3);
    expect(chain.policyBreaks.join(' ')).toMatch(/ohne externen RFC-3161-Anker/);
    expect(recovery.ok).toBe(true);
    expect(recovery.policyBreaks).toEqual([]);
  });

  it('meldet einen verschwundenen Recovery-Checkpoint als Policy-Bruch', async () => {
    const rows = buildChain(3);
    const recovery = await service.verifyRecoverySegment(makeTx(rows, []).tx, TENANT, 424_242n, {
      requireExternalTsa: true,
    });

    expect(recovery.ok).toBe(false);
    expect(recovery.checked).toBe(0);
    expect(recovery.policyBreaks).toEqual([
      'Recovery-Checkpoint Audit-ID 424242 existiert nicht mehr.',
    ]);
  });
});
