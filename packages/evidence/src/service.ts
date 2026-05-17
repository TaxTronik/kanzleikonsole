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
import { canonicalJson } from './canonical-json';
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

    // 3. Kanonisches Event-Objekt für die Hash-Berechnung.
    const occurredAt = new Date();
    const canonical = {
      tenantId: event.tenantId,
      occurredAt: occurredAt.toISOString(),
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      before: event.before ?? null,
      after: event.after ?? null,
    };
    const canonicalBytes = Buffer.from(canonicalJson(canonical), 'utf8');

    // 4. SHA-256(prev_hash || canonical).
    const thisHash = createHash('sha256')
      .update(prevHash)
      .update(canonicalBytes)
      .digest();

    // 5. INSERT.
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
        ${event.before ? JSON.stringify(event.before) : null}::jsonb,
        ${event.after ? JSON.stringify(event.after) : null}::jsonb,
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
  async verifyChain(tx: Tx, tenantId: string): Promise<VerificationResult> {
    const result: VerificationResult = {
      ok: true,
      checked: 0,
      sealsChecked: 0,
      sealBreaks: [],
    };

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

      const canonical = {
        tenantId,
        occurredAt: r.occurred_at.toISOString(),
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        before: r.before ?? null,
        after: r.after ?? null,
      };
      const computed = createHash('sha256')
        .update(expectedPrev)
        .update(Buffer.from(canonicalJson(canonical), 'utf8'))
        .digest();

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

      expectedPrev = Buffer.from(r.this_hash);
      result.checked++;
    }

    // 2. Tages-Stempel verifizieren.
    const seals = await tx.$queryRaw<
      Array<{
        seal_date: Date;
        top_hash: Buffer;
        tsa_response_blob: Buffer | null;
      }>
    >`
      SELECT seal_date, top_hash, tsa_response_blob
      FROM audit_seal
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY seal_date ASC
    `;

    for (const s of seals) {
      const sealOk = await this.timestampPort.verify(
        Buffer.from(s.top_hash),
        s.tsa_response_blob ? Buffer.from(s.tsa_response_blob) : null,
      );
      if (!sealOk) {
        result.ok = false;
        result.sealBreaks.push({
          sealDate: s.seal_date,
          reason: 'TSA-Verifikation fehlgeschlagen',
        });
      }
      result.sealsChecked++;
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
