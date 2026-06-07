// =============================================================================
// EvidenceService — Manipulationsevidenz für taxtronik.
//
// Schreibt Audit-Events in eine hash-verkettete, append-only Tabelle (audit_log)
// und versiegelt täglich den Tages-Spitzen-Hash mit RFC-3161 (audit_seal).
//
// Mechanik:
//   this_hash = SHA-256(prev_hash || canonical_json(event))
//
// Genesis (kein Vorgänger):
//   prev_hash = SHA-256("taxtronik-genesis:" || tenant_id)
//
// Concurrency:
//   Pro-Tenant Advisory-Lock innerhalb der Transaktion serialisiert Inserts.
//
// Verifikation (CLI / Wirtschaftsprüfer):
//   verifyChain(tenantId) rechnet alle Hashes nach und prüft TSA-Stempel.
// =============================================================================

import { createHash } from 'node:crypto';
import type { PrismaClient, AuditActorType } from '@prisma/client';
import { eventHash, chainValue } from './chain';
import type { TimestampPort } from './ports/timestamp';

type Tx = Pick<PrismaClient, '$queryRaw' | '$queryRawUnsafe' | '$executeRaw'>;

const GENESIS_PREFIX = Buffer.from('taxtronik-genesis:', 'utf8');

export interface AuditEventInput {
  tenantId: string;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export interface RecordedEvent {
  id: bigint;
  occurredAt: Date;
  prevHash: Buffer;
  thisHash: Buffer;
}

export interface VerificationResult {
  ok: boolean;
  checked: number;
  firstBreak?: {
    auditId: bigint;
    occurredAt: Date;
    expectedHash: string;
    actualHash: string;
  };
  sealsChecked: number;
  sealBreaks: Array<{ sealDate: Date; reason: string }>;
  /** Welcher Zeitstempel-Adapter geprüft hat — IMMER ausgewiesen (Audit-Transparenz). */
  tsaMode: 'local' | 'rfc3161';
  /** Policy-Verstöße (z. B. Self-Timestamp im Produktivmodus). */
  policyBreaks: string[];
}

export interface VerifyChainOptions {
  /**
   * Wenn true UND der Adapter im 'local'-Modus läuft → harter Fail: ein
   * Self-Timestamp ist im Produktivbetrieb kein gerichtsfester Drittnachweis.
   * Default false (Lib bleibt umgebungsfrei); die Verify-Werkzeuge (CLI, täglicher
   * Worker-Check) setzen es aus NODE_ENV/EVIDENCE_REQUIRE_TSA.
   */
  requireExternalTsa?: boolean;
}

export class EvidenceService {
  constructor(private readonly timestampPort: TimestampPort) {}

  /**
   * Schreibt einen Audit-Event in die Hash-Chain.
   *
   * MUSS innerhalb einer Transaktion aufgerufen werden, in der auch die
   * fachliche Schreiboperation läuft (Konsistenz garantiert).
   *
   * Beispiel:
   * ```ts
   * await prisma.$transaction(async (tx) => {
   *   const client = await tx.client.create({ data: ... });
   *   await evidence.record(tx, {
   *     tenantId, actorType: 'STAFF', actorId, action: 'client.create',
   *     resourceType: 'client', resourceId: client.id, after: client,
   *   });
   * });
   * ```
   */
  async record(tx: Tx, event: AuditEventInput): Promise<RecordedEvent> {
    // 1. Advisory-Lock pro Tenant — serialisiert Audit-Inserts.
    //    pg_advisory_xact_lock(int8): Lock wird mit Transaktions-Ende freigegeben.
    //    Der Lock-Key ist hash(audit-chain:<tenantId>) als 64-Bit-Int.
    const lockKey = computeLockKey(event.tenantId);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

    // 2. Vorgänger-Hash holen (oder Genesis).
    const prevRows = await tx.$queryRaw<{ this_hash: Buffer }[]>`
      SELECT this_hash FROM audit_log
      WHERE tenant_id = ${event.tenantId}::uuid
      ORDER BY id DESC
      LIMIT 1
    `;
    const prevHash = prevRows[0]?.this_hash ?? genesisHash(event.tenantId);

    // 3. Event-Hash über die EINE zentrale Funktion (chain.ts) — dieselbe nutzen
    //    der Live-Verify (unten) UND der Offline-Archiv-Verifier (archive.ts),
    //    daher ist eine Drift zwischen Record- und Verify-Berechnung ausgeschlossen
    //    (Review F1/A2). chainValue normalisiert before/after auf den jsonb-
    //    Roundtrip → Record == Verify auch für Decimal/Buffer/falsy; GENAU diese
    //    normalisierte Form wird unten als jsonb gespeichert.
    const occurredAt = new Date();
    const beforeN = chainValue(event.before);
    const afterN = chainValue(event.after);
    const thisHash = eventHash(prevHash, {
      tenantId: event.tenantId,
      occurredAt,
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      before: event.before,
      after: event.after,
    });

    // 4. INSERT.
    const inserted = await tx.$queryRaw<{ id: bigint; occurred_at: Date }[]>`
      INSERT INTO audit_log (
        tenant_id, occurred_at, actor_type, actor_id, action,
        resource_type, resource_id, "before", "after", ip, user_agent,
        prev_hash, this_hash
      ) VALUES (
        ${event.tenantId}::uuid,
        ${occurredAt},
        ${event.actorType}::audit_actor_type,
        ${event.actorId}::uuid,
        ${event.action},
        ${event.resourceType},
        ${event.resourceId ?? null},
        ${beforeN === null ? null : JSON.stringify(beforeN)}::jsonb,
        ${afterN === null ? null : JSON.stringify(afterN)}::jsonb,
        ${event.ip ?? null}::inet,
        ${event.userAgent ?? null},
        ${prevHash},
        ${thisHash}
      )
      RETURNING id, occurred_at
    `;

    const row = inserted[0]!;
    return {
      id: row.id,
      occurredAt: row.occurred_at,
      prevHash,
      thisHash,
    };
  }

  /**
   * Versiegelt den Tages-Spitzen-Hash mit RFC-3161 (oder lokalem Self-Timestamp).
   * Wird vom Worker täglich aufgerufen (Job `evidence:seal:daily`).
   *
   * Idempotent: Doppel-Aufruf für dasselbe (tenant, sealDate) ist No-Op.
   */
  async sealDay(
    tx: Tx,
    tenantId: string,
    sealDate: Date,
  ): Promise<{ sealed: boolean; reason?: string }> {
    // 1. Bereits versiegelt?
    const existing = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
        AND seal_date = ${dateOnly(sealDate)}::date
      LIMIT 1
    `;
    if (existing.length > 0) {
      return { sealed: false, reason: 'bereits versiegelt' };
    }

    // 2. Top-Eintrag des Tages holen.
    const top = await tx.$queryRaw<{ id: bigint; this_hash: Buffer }[]>`
      SELECT id, this_hash FROM audit_log
      WHERE tenant_id = ${tenantId}::uuid
        AND occurred_at::date = ${dateOnly(sealDate)}::date
      ORDER BY id DESC
      LIMIT 1
    `;
    if (top.length === 0) {
      return { sealed: false, reason: 'kein Audit-Event an diesem Tag' };
    }
    const topRow = top[0]!;

    // 3. RFC-3161-Stempel holen.
    const stamp = await this.timestampPort.timestamp(topRow.this_hash);

    // 4. INSERT.
    await tx.$executeRaw`
      INSERT INTO audit_seal (
        tenant_id, seal_date, top_audit_id, top_hash,
        tsa_request_blob, tsa_response_blob, tsa_serial, sealed_at, sealed_by
      ) VALUES (
        ${tenantId}::uuid,
        ${dateOnly(sealDate)}::date,
        ${topRow.id},
        ${topRow.this_hash},
        ${stamp.tsaRequestBlob ? Buffer.from(stamp.tsaRequestBlob) : null},
        ${stamp.tsaResponseBlob ? Buffer.from(stamp.tsaResponseBlob) : null},
        ${stamp.tsaSerial},
        ${new Date(stamp.timestampedAt)},
        ${'system'}
      )
    `;

    return { sealed: true };
  }

  /**
   * Rechnet die Hash-Chain für einen Tenant nach und prüft alle Tages-Stempel.
   * Wird von der CLI (`pnpm verify:chain`) und vom Admin-UI aufgerufen.
   */
  async verifyChain(
    tx: Tx,
    tenantId: string,
    opts: VerifyChainOptions = {},
  ): Promise<VerificationResult> {
    const result: VerificationResult = {
      ok: true,
      checked: 0,
      sealsChecked: 0,
      sealBreaks: [],
      tsaMode: this.timestampPort.mode,
      policyBreaks: [],
    };

    // Policy: Self-Timestamp im Produktivmodus ist kein Drittnachweis → harter Fail.
    // (Der Modus wird oben unabhängig davon IMMER im Report ausgewiesen.)
    if (opts.requireExternalTsa && this.timestampPort.mode === 'local') {
      result.ok = false;
      result.policyBreaks.push(
        'Self-Timestamp (LocalTimestampAdapter) im Produktivmodus unzulässig — ' +
          'externe RFC-3161-TSA erforderlich (TIMESTAMP_AUTHORITY_URL setzen).',
      );
    }

    // Seals VORAB laden — ihre top_audit_id steuert, welchen rekonstruierten
    // Ketten-Hash wir während des Walks festhalten müssen (Punkt 2: der TSA-
    // Imprint wird gegen DIESEN Wert geprüft, nie gegen die gespeicherte Spalte).
    const seals = await tx.$queryRaw<
      Array<{
        seal_date: Date;
        top_audit_id: bigint;
        top_hash: Buffer;
        tsa_response_blob: Buffer | null;
      }>
    >`
      SELECT seal_date, top_audit_id, top_hash, tsa_response_blob
      FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY seal_date ASC
    `;
    const sealTopIds = new Set<bigint>(seals.map((s) => s.top_audit_id));
    const recomputedTops = new Map<bigint, Buffer>();

    // 1. Audit-Chain durchgehen.
    const rows = await tx.$queryRaw<
      Array<{
        id: bigint;
        occurred_at: Date;
        actor_type: AuditActorType;
        actor_id: string | null;
        action: string;
        resource_type: string;
        resource_id: string | null;
        before: unknown;
        after: unknown;
        prev_hash: Buffer;
        this_hash: Buffer;
      }>
    >`
      SELECT id, occurred_at, actor_type, actor_id, action,
             resource_type, resource_id, "before", "after",
             prev_hash, this_hash
      FROM audit_log
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY id ASC
    `;

    let expectedPrev = genesisHash(tenantId);
    for (const r of rows) {
      // prev_hash muss mit erwartetem Vorgänger übereinstimmen
      if (!Buffer.from(r.prev_hash).equals(expectedPrev)) {
        result.ok = false;
        result.firstBreak = {
          auditId: r.id,
          occurredAt: r.occurred_at,
          expectedHash: expectedPrev.toString('hex'),
          actualHash: Buffer.from(r.prev_hash).toString('hex'),
        };
        return result;
      }

      const computed = eventHash(expectedPrev, {
        tenantId,
        occurredAt: r.occurred_at,
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        before: r.before,
        after: r.after,
      });

      if (!computed.equals(Buffer.from(r.this_hash))) {
        result.ok = false;
        result.firstBreak = {
          auditId: r.id,
          occurredAt: r.occurred_at,
          expectedHash: computed.toString('hex'),
          actualHash: Buffer.from(r.this_hash).toString('hex'),
        };
        return result;
      }

      // Den AUS DER KETTE REKONSTRUIERTEN Spitzen-Hash dieses Eintrags festhalten,
      // falls er versiegelt wurde — er (nicht die DB-Spalte) ist der Prüfwert unten.
      if (sealTopIds.has(r.id)) recomputedTops.set(r.id, computed);

      expectedPrev = Buffer.from(r.this_hash);
      result.checked++;
    }

    // 2. Tages-Stempel verifizieren — gegen den REKONSTRUIERTEN Ketten-Hash.
    //    NIE gegen audit_seal.top_hash (gespeicherte Spalte): das wäre DB-gegen-DB
    //    und ließe einen Angreifer, der die History konsistent umschreibt, passieren.
    //    Der Prüfwert kommt ausschließlich aus dem SHA-256-Walk oben.
    for (const s of seals) {
      result.sealsChecked++;
      const recomputed = recomputedTops.get(s.top_audit_id);
      if (!recomputed) {
        // Der versiegelte Spitzen-Eintrag existiert nicht mehr in der rekonstruierten
        // Kette (gelöscht/abgeschnitten) — der Stempel hängt in der Luft.
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: `versiegelter Spitzen-Eintrag (audit_id ${s.top_audit_id}) fehlt in der rekonstruierten Kette`,
        });
        continue;
      }
      // Spalten-Integrität: gespeicherter top_hash MUSS dem rekonstruierten Hash
      // entsprechen. Fängt DB-Manipulation auch dann, wenn ein lokaler Adapter
      // keinen kryptografischen verify() leistet (verify() gibt dort immer true).
      if (!recomputed.equals(Buffer.from(s.top_hash))) {
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: 'gespeicherter top_hash weicht vom rekonstruierten Ketten-Hash ab (DB-Manipulationsverdacht)',
        });
        continue;
      }
      // TSA-Bindung: der messageImprint im Token muss an den rekonstruierten Hash
      // binden. Schlägt fehl, sobald die History umgeschrieben wurde (Token trägt
      // den alten Imprint, die Kette rechnet jetzt einen anderen Spitzen-Hash).
      const sealOk = await this.timestampPort.verify(
        recomputed,
        s.tsa_response_blob ? Buffer.from(s.tsa_response_blob) : null,
      );
      if (!sealOk) {
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: 'TSA-Verifikation gegen rekonstruierten Ketten-Spitzen-Hash fehlgeschlagen',
        });
      }
    }

    return result;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function genesisHash(tenantId: string): Buffer {
  return createHash('sha256')
    .update(GENESIS_PREFIX)
    .update(Buffer.from(tenantId, 'utf8'))
    .digest();
}

function dateOnly(d: Date): string {
  // YYYY-MM-DD in UTC für Date-Spalten.
  return d.toISOString().slice(0, 10);
}

function computeLockKey(tenantId: string): bigint {
  // 64-Bit-Lock-Key aus den ersten 8 Bytes des SHA-256 von "audit-chain:<tenantId>".
  // Determ., kollisionsarm, und passt in Postgres' bigint.
  const hash = createHash('sha256').update(`audit-chain:${tenantId}`).digest();
  return hash.readBigInt64BE(0);
}
