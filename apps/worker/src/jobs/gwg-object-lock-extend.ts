// =============================================================================
// gwg-object-lock-extend: Object-Lock gebundener GwG-Belege verlängern
// (RT3D-K-01, kk-tcms-fix5; TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001).
//
// Ein GwG-Beleg mit Verweis des Tax-CMS gilt zugleich als steuerliche
// Unterlage; die Datenbank hebt sein Aufbewahrungsende (document.retention_
// until) auf die Steuerfrist bzw. das Ende der GwG-Frist und lässt es nie mehr
// sinken (Migrationen 20261021150000, 20261021171000). Der GOVERNANCE-Lock
// seiner Objektversionen im GwG-Bucket blieb bei 5 Jahren und 1 Tag ab Upload;
// allein die Datenbank hielt die längere Frist. Dieser Job zieht den Lock
// jeder Objektversion bis zum Aufbewahrungsende nach – als zweite Linie neben
// der Datenbank. Die GwG-Vernichtung übersteuert den Lock dieser Belege nicht
// (kein BypassGovernanceRetention, admin/gwg-retention/actions.ts).
//
// Ablauf: nach dem Commit (der Job liest nur festgeschriebene Stände), stündlich
// und idempotent. Kandidaten sind die Versionen im GwG-Bucket eines nicht
// vernichteten und nicht vorgemerkten GwG-Belegs mit Verweis, dessen
// Aufbewahrungsende in der Zukunft liegt und dessen nachgelesenes Lock-Ende
// (gwg_object_lock_extension.retain_until) davor liegt oder fehlt. Je Kandidat
// verlängert @taxtronik/storage den Lock der exakten Version (nur verlängern,
// nie verkürzen, nachlesen). Erfolg und Fehlschlag (fester Code) stehen je
// Version in gwg_object_lock_extension; ein gescheiterter Kandidat kommt im
// nächsten Lauf wieder. Den Altbestand verlängert der erste Lauf nach dem
// Update (einmaliger Nachlauf, danach nur neu angehobene Enden).
//
// Status und Alarm: Das Job-Ergebnis nennt Zahlen und den Rückstand
// (System → Jobs, GET /api/health/detail); maintenance-backlog.ts alarmiert ab
// der Schwelle der Wartungsjobs (B14) mit einem Hinweis an die aktiven
// ADMIN/PARTNER der Kanzlei (SYSTEM_GWG_OBJECT_LOCK_BACKLOG) und einer Mail an
// OPS_ALERT_EMAIL. Jeder Fehlschlag wird zusätzlich als Fehler protokolliert
// (Dokument- und Versions-ID, Code; keine Schlüssel oder Antworttexte).
//
// S-01: Kandidaten über alle Tenants und die Owner-only-Tabelle liest und
// schreibt der Owner-Client (wie storage-orphan-cleanup); die App-Rolle hat auf
// gwg_object_lock_extension keine Rechte.
// =============================================================================

import type { Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { extendObjectLockRetention, getBucketForTier } from '@taxtronik/storage';
import { createWorker } from '../worker-factory';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { log } from '../logger';
import { isWorkerClosing, startRunBudget, type RunBudget } from '../run-budget';
import {
  recordMaintenanceBacklog,
  type MaintenanceBacklogStatus,
  type TenantBacklog,
} from '../maintenance-backlog';

export const GWG_OBJECT_LOCK_BATCH_SIZE = 100;

interface Candidate {
  tenantId: string;
  documentId: string;
  versionId: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string | null;
  /** Aufbewahrungsende des Dokuments: Ziel des Locks. */
  target: Date;
}

/** Begrenzung eines gezielten Laufs (Tests); ohne Angabe alle Tenants. */
export interface GwgObjectLockScope {
  tenantIds?: readonly string[];
}

/** Offene Kandidaten (Auswahl und Rückstand teilen die Bedingung). */
function openCandidates(bucket: string, now: Date, scope: GwgObjectLockScope): Prisma.Sql {
  const tenants = scope.tenantIds
    ? Prisma.sql`AND d."tenant_id" = ANY(${[...scope.tenantIds]}::uuid[])`
    : Prisma.empty;
  return Prisma.sql`
      FROM "document" d
      JOIN "document_version" v ON v."document_id" = d."id"
      LEFT JOIN "gwg_object_lock_extension" s ON s."document_version_id" = v."id"
     WHERE d."classification" = 'GWG_EVIDENCE'
       AND d."gwg_destroyed_at" IS NULL
       AND d."gwg_destruction_requested_at" IS NULL
       AND d."retention_until" > ${now}::timestamptz AT TIME ZONE 'UTC'
       AND EXISTS (
         SELECT 1 FROM "tcms_document_reference" r
          WHERE r."document_id" = d."id" AND r."tenant_id" = d."tenant_id"
       )
       AND v."storage_bucket" = ${bucket}
       AND (s."retain_until" IS NULL OR s."retain_until" < d."retention_until")
       ${tenants}`;
}

function findCandidates(
  bucket: string,
  now: Date,
  scope: GwgObjectLockScope,
  after: string | null,
): Promise<Candidate[]> {
  return prismaOwner.$queryRaw<Candidate[]>`
    SELECT d."tenant_id" AS "tenantId", d."id" AS "documentId", v."id" AS "versionId",
           v."storage_bucket" AS "storageBucket", v."storage_key" AS "storageKey",
           v."storage_version_id" AS "storageVersionId", d."retention_until" AS "target"
    ${openCandidates(bucket, now, scope)}
       AND (${after}::uuid IS NULL OR v."id" > ${after}::uuid)
     ORDER BY v."id"
     LIMIT ${GWG_OBJECT_LOCK_BATCH_SIZE}`;
}

/** Rückstand je Tenant; fällig seit dem ersten Fehlschlag, sonst seit jetzt. */
async function measureBacklog(
  bucket: string,
  now: Date,
  scope: GwgObjectLockScope,
): Promise<TenantBacklog[]> {
  const rows = await prismaOwner.$queryRaw<
    Array<{ tenantId: string; count: bigint; oldestDueAt: Date | null }>
  >`
    SELECT d."tenant_id" AS "tenantId", count(*)::bigint AS "count",
           min(COALESCE(s."failed_since", ${now}::timestamptz)) AS "oldestDueAt"
    ${openCandidates(bucket, now, scope)}
     GROUP BY d."tenant_id"`;
  return rows.map((row) => ({
    tenantId: row.tenantId,
    count: Number(row.count),
    oldestDueAt: row.oldestDueAt,
  }));
}

/** Fester Code eines Fehlschlags (CHECK gwg_object_lock_extension_last_error_check). */
export function lockErrorCode(error: unknown): string {
  const code =
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : error instanceof Error
        ? error.name
        : '';
  return /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : 'UNBEKANNT';
}

async function recordSuccess(candidate: Candidate, retainUntil: Date): Promise<void> {
  // Nie zurück: ein später gelesener, kürzerer Stand ersetzt keinen längeren.
  await prismaOwner.$executeRaw`
    INSERT INTO "gwg_object_lock_extension"
      ("document_version_id", "tenant_id", "retain_until", "checked_at",
       "failed_since", "failed_attempts", "last_error")
    VALUES (${candidate.versionId}::uuid, ${candidate.tenantId}::uuid,
            ${retainUntil}::timestamptz AT TIME ZONE 'UTC', now(), NULL, 0, NULL)
    ON CONFLICT ("document_version_id") DO UPDATE
       SET "retain_until" = GREATEST(
             COALESCE("gwg_object_lock_extension"."retain_until", EXCLUDED."retain_until"),
             EXCLUDED."retain_until"),
           "checked_at" = now(),
           "failed_since" = NULL,
           "failed_attempts" = 0,
           "last_error" = NULL`;
}

async function recordFailure(candidate: Candidate, code: string): Promise<void> {
  await prismaOwner.$executeRaw`
    INSERT INTO "gwg_object_lock_extension"
      ("document_version_id", "tenant_id", "retain_until", "checked_at",
       "failed_since", "failed_attempts", "last_error")
    VALUES (${candidate.versionId}::uuid, ${candidate.tenantId}::uuid, NULL, now(),
            now(), 1, ${code})
    ON CONFLICT ("document_version_id") DO UPDATE
       SET "checked_at" = now(),
           "failed_since" = COALESCE("gwg_object_lock_extension"."failed_since", now()),
           "failed_attempts" = "gwg_object_lock_extension"."failed_attempts" + 1,
           "last_error" = EXCLUDED."last_error"`;
}

type Outcome = 'extended' | 'unchanged' | 'failed';

async function processCandidate(candidate: Candidate): Promise<Outcome> {
  const fields = {
    component: 'gwg-object-lock-extend',
    tenantId: candidate.tenantId,
    documentId: candidate.documentId,
    versionId: candidate.versionId,
  };
  let result;
  try {
    result = await extendObjectLockRetention(
      {
        bucket: candidate.storageBucket,
        key: candidate.storageKey,
        versionId: candidate.storageVersionId ?? '',
      },
      candidate.target,
    );
  } catch (error) {
    const code = lockErrorCode(error);
    log.error({ ...fields, code }, 'gwg-object-lock-extend: Object-Lock nicht verlängert');
    try {
      await recordFailure(candidate, code);
    } catch (dbError) {
      log.error(
        { ...fields, err: dbError instanceof Error ? dbError.message.slice(0, 300) : null },
        'gwg-object-lock-extend: Fehlschlag nicht festgehalten',
      );
    }
    return 'failed';
  }
  await recordSuccess(candidate, result.retainUntil);
  return result.status === 'VERLAENGERT' ? 'extended' : 'unchanged';
}

export interface GwgObjectLockExtendResult {
  /** Bearbeitete Objektversionen. */
  examined: number;
  /** Lock verlängert und nachgelesen. */
  extended: number;
  /** Lock lag schon auf oder hinter dem Aufbewahrungsende (nur vermerkt). */
  unchanged: number;
  /** Verlängern gescheitert; bleibt für den nächsten Lauf offen. */
  failed: number;
  /** Nach dem Lauf weiterhin offene Objektversionen (alle Tenants). */
  backlog: number;
  /** Der Lauf endete am Zeitbudget oder wegen Herunterfahrens. */
  budgetExhausted: boolean;
  /** B14: Health-Kennzahl und Alarm (maintenance-backlog.ts). */
  backlogStatus: MaintenanceBacklogStatus;
}

/**
 * Ein Lauf über alle offenen Objektversionen bis zum Zeitbudget (geplanter Job)
 * oder nur über `scope.tenantIds` (gezielter Lauf, Tests). In einem Lauf
 * gescheiterte Versionen kommen erst im nächsten wieder an die Reihe (Keyset
 * nach Versions-ID).
 */
export async function runGwgObjectLockExtend(
  now: Date = new Date(),
  budget: RunBudget = startRunBudget(),
  scope: GwgObjectLockScope = {},
): Promise<GwgObjectLockExtendResult> {
  const bucket = getBucketForTier('GWG');
  const totals = { examined: 0, extended: 0, unchanged: 0, failed: 0 };
  let after: string | null = null;
  let budgetExhausted = false;
  for (;;) {
    if (budget.exhausted()) {
      budgetExhausted = true;
      break;
    }
    const batch: Candidate[] = await findCandidates(bucket, now, scope, after);
    for (const candidate of batch) {
      if (budget.exhausted()) {
        budgetExhausted = true;
        break;
      }
      totals[await processCandidate(candidate)] += 1;
      totals.examined += 1;
      after = candidate.versionId;
    }
    if (budgetExhausted || batch.length < GWG_OBJECT_LOCK_BATCH_SIZE) break;
  }
  const tenantBacklogs = await measureBacklog(bucket, now, scope);
  const backlog = tenantBacklogs.reduce((sum, tenant) => sum + tenant.count, 0);
  const backlogStatus = await recordMaintenanceBacklog('gwgObjectLockExtend', tenantBacklogs, now);
  const result: GwgObjectLockExtendResult = {
    ...totals,
    backlog,
    budgetExhausted,
    backlogStatus,
  };
  const summary = { component: 'gwg-object-lock-extend', ...result };
  if (result.failed > 0 || backlogStatus.alarm)
    log.warn(summary, 'gwg-object-lock-extend finished');
  else log.info(summary, 'gwg-object-lock-extend finished');
  return result;
}

// Typ explizit: der Processor liest `closing` des eigenen Workers (P-17).
export const gwgObjectLockExtendWorker: Worker<Record<string, never>> = createWorker<
  Record<string, never>
>(
  JOB_QUEUES.gwgObjectLockExtend.name,
  async () =>
    runGwgObjectLockExtend(
      new Date(),
      startRunBudget({ stop: () => isWorkerClosing(gwgObjectLockExtendWorker) }),
    ),
  { connection, concurrency: 1 },
);
