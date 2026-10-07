// =============================================================================
// pdf-page-count-backfill: Seitenzahl von PDF-Ausweisquellen nachtragen (P-13)
//
// Die Prüfung eines Ausweisausschnitts braucht bei PDFs die Seitenzahl der
// gebundenen Version. Sie wird beim Upload gespeichert
// (document_version.pdf_page_count); fehlt sie, zählt die Prüfung vor ihrer
// gesperrten Transaktion (Download, Hashprüfung, Worker-Thread). Dieser Job
// trägt den Wert für Versionen ohne Zählung nach: Altbestand vor Migration
// 20261005140000, nachträglich als GwG-Beleg eingestufte Dokumente und beim
// Upload nicht lesbare Dateien.
//
// Kandidaten sind genau die Versionen, die die Ausschnittsprüfung als PDF-Quelle
// zählen würde (loadIdentitySourceTx in apps/web/src/server/gwg/identity-source.ts):
// neueste Version eines nicht gelöschten, nicht in Vernichtung befindlichen
// GwG-Belegs mit MIME-Typ application/pdf, CLEAN mit Objektversion, höchstens
// 25 MiB. Ausgelassen werden Belege, die einem Ausweissatz zugeordnet sind
// (gwg_id_document): Deren Versionen sperrt block_version_during_gwg_destruction
// gegen jede Änderung; ihre Seitenzahl zählt die Prüfung weiter vorab.
//
// Je Kandidat: Bytes mit Längen- und SHA-256-Prüfung laden, im begrenzten
// Worker-Thread zählen (dasselbe Programm und dieselben Grenzen wie beim
// Upload, @taxtronik/mail/pdf-page-count), Ergebnis nur für dieselbe Version
// mit unverändertem Hash und unveränderter Objektversion speichern. Gezählte
// und nicht lesbare Versionen (auch Hashabweichungen) erhalten
// pdf_page_count_checked_at und kommen nicht wieder; ohne verwertbares Ergebnis
// (Speicher- oder Thread-Fehler) bleibt die Version für den nächsten Lauf offen.
//
// Idempotent und wiederaufnehmbar: Der Zustand liegt allein in den beiden
// Spalten; ein abgebrochener Lauf setzt beim nächsten an den offenen Versionen
// an. Je Tenant in Stapeln (Keyset nach Dokument-ID) unter der App-Rolle mit
// RLS (withSystemContext); nur die Tenant-Liste liest der Owner. Ein Lauf endet
// am Zeitbudget der Wartungsjobs (P-17) oder nach drei Speicher- bzw.
// Thread-Fehlern in Folge und meldet den verbleibenden Rückstand.
// =============================================================================

import type { Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { withSystemContext, type TxClient } from '@taxtronik/db';
import { countPdfPagesInWorkerThread } from '@taxtronik/mail/pdf-page-count-node';
import { fetchVerifiedObjectBytes, StoredObjectError } from '@taxtronik/storage';
import { createWorker } from '../worker-factory';
import { connection } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { log } from '../logger';
import { isWorkerClosing, startRunBudget, type RunBudget } from '../run-budget';

export const PDF_PAGE_COUNT_BATCH_SIZE = 50;
/** Größte Ausweisquelle, die die Ausschnittsprüfung annimmt (loadIdentitySourceTx). */
export const IDENTITY_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
/** So viele Speicher- bzw. Thread-Fehler in Folge beenden den Lauf. */
export const MAX_CONSECUTIVE_FAILURES = 3;

interface Candidate {
  documentId: string;
  versionId: string;
  storageBucket: string;
  storageKey: string;
  storageVersionId: string;
  sha256: Uint8Array;
  sizeBytes: bigint;
}

/** Offene Kandidaten eines Tenants (Auswahl und Rückstand teilen die Bedingung). */
function openCandidates(tenantId: string): Prisma.Sql {
  return Prisma.sql`
      FROM "document" d
      CROSS JOIN LATERAL (
        SELECT dv.* FROM "document_version" dv
         WHERE dv."document_id" = d."id"
         ORDER BY dv."version_no" DESC
         LIMIT 1
      ) v
     WHERE d."tenant_id" = ${tenantId}::uuid
       AND d."classification" = 'GWG_EVIDENCE'
       AND d."mime_type" = 'application/pdf'
       AND d."deleted_at" IS NULL
       AND d."gwg_destroyed_at" IS NULL
       AND d."gwg_destruction_requested_at" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "gwg_id_document" g WHERE g."document_id" = d."id")
       AND v."pdf_page_count" IS NULL
       AND v."pdf_page_count_checked_at" IS NULL
       AND v."scan_status" = 'CLEAN'
       AND v."scan_completed_at" IS NOT NULL
       AND v."storage_version_id" IS NOT NULL
       AND v."storage_version_id" <> ''
       AND v."size_bytes" <= ${BigInt(IDENTITY_SOURCE_MAX_BYTES)}`;
}

function findCandidatesTx(
  tx: TxClient,
  tenantId: string,
  after: string | null,
): Promise<Candidate[]> {
  return tx.$queryRaw<Candidate[]>`
    SELECT d."id" AS "documentId", v."id" AS "versionId",
           v."storage_bucket" AS "storageBucket", v."storage_key" AS "storageKey",
           v."storage_version_id" AS "storageVersionId", v."sha256",
           v."size_bytes" AS "sizeBytes"
    ${openCandidates(tenantId)}
       AND (${after}::uuid IS NULL OR d."id" > ${after}::uuid)
     ORDER BY d."id"
     LIMIT ${PDF_PAGE_COUNT_BATCH_SIZE}`;
}

async function countBacklogTx(tx: TxClient, tenantId: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ open: bigint }>>`
    SELECT count(*) AS "open" ${openCandidates(tenantId)}`;
  return Number(row?.open ?? 0);
}

/**
 * Speichert das Ergebnis nur für dieselbe, noch ungeprüfte Version mit
 * unveränderter Speicheridentität; `pages === null` markiert „nicht lesbar“.
 * Liefert, ob genau diese Zeile aktualisiert wurde.
 */
async function settleCandidate(
  tenantId: string,
  candidate: Candidate,
  pages: number | null,
): Promise<boolean> {
  const updated = await withSystemContext(
    tenantId,
    (tx) => tx.$executeRaw`
      UPDATE "document_version"
         SET "pdf_page_count" = ${pages}::integer,
             "pdf_page_count_checked_at" = now()
       WHERE "id" = ${candidate.versionId}::uuid
         AND "document_id" = ${candidate.documentId}::uuid
         AND "pdf_page_count" IS NULL
         AND "pdf_page_count_checked_at" IS NULL
         AND "sha256" = ${Buffer.from(candidate.sha256)}
         AND "storage_version_id" = ${candidate.storageVersionId}`,
  );
  return updated === 1;
}

type Outcome = 'counted' | 'unreadable' | 'integrity' | 'skipped' | 'failed';

function logFields(tenantId: string, candidate: Candidate) {
  return {
    component: 'pdf-page-count-backfill',
    tenantId,
    documentId: candidate.documentId,
    versionId: candidate.versionId,
  };
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message.slice(0, 500) : null;
}

/** Bytes der Version oder der Ausgang, wenn sie nicht verwertbar sind. */
async function readCandidateBytes(
  tenantId: string,
  candidate: Candidate,
): Promise<Buffer | 'integrity' | 'failed'> {
  try {
    return await fetchVerifiedObjectBytes(
      {
        bucket: candidate.storageBucket,
        key: candidate.storageKey,
        versionId: candidate.storageVersionId,
      },
      { sizeBytes: candidate.sizeBytes, sha256: Buffer.from(candidate.sha256) },
      { maxBytes: IDENTITY_SOURCE_MAX_BYTES },
    );
  } catch (error) {
    if (error instanceof StoredObjectError && error.integrityViolation) {
      // Die Ausschnittsprüfung lehnt diese Quelle ohnehin als geänderte Datei ab.
      log.error(
        { ...logFields(tenantId, candidate), reason: error.reason },
        'pdf-page-count-backfill: gespeichertes Objekt weicht von der Version ab',
      );
      return 'integrity';
    }
    log.warn(
      { ...logFields(tenantId, candidate), err: errorMessage(error) },
      'pdf-page-count-backfill: Objekt nicht lesbar, nächster Lauf versucht es erneut',
    );
    return 'failed';
  }
}

/** Seitenzahl bzw. `null` (nicht lesbar, Hashabweichung) oder `failed` (kein Urteil). */
async function countCandidate(
  tenantId: string,
  candidate: Candidate,
): Promise<{ outcome: 'counted' | 'unreadable' | 'integrity'; pages: number | null } | 'failed'> {
  const bytes = await readCandidateBytes(tenantId, candidate);
  if (bytes === 'failed') return 'failed';
  if (bytes === 'integrity') return { outcome: 'integrity', pages: null };
  const counted = await countPdfPagesInWorkerThread(bytes);
  if (counted.status === 'unavailable') {
    log.error(
      { ...logFields(tenantId, candidate), reason: counted.reason },
      'pdf-page-count-backfill: Worker-Thread ohne Ergebnis',
    );
    return 'failed';
  }
  return counted.status === 'counted'
    ? { outcome: 'counted', pages: counted.pages }
    : { outcome: 'unreadable', pages: null };
}

async function processCandidate(tenantId: string, candidate: Candidate): Promise<Outcome> {
  const result = await countCandidate(tenantId, candidate);
  if (result === 'failed') return 'failed';
  try {
    return (await settleCandidate(tenantId, candidate, result.pages)) ? result.outcome : 'skipped';
  } catch (error) {
    // Z. B. inzwischen einem Ausweissatz zugeordnet (Trigger sperrt die
    // Version); der nächste Lauf wählt die Version dann nicht mehr aus.
    log.warn(
      { ...logFields(tenantId, candidate), err: errorMessage(error) },
      'pdf-page-count-backfill: Ergebnis nicht gespeichert',
    );
    return 'skipped';
  }
}

export interface PdfPageCountBackfillResult {
  /** Bearbeitete Kandidaten. */
  examined: number;
  counted: number;
  /** Von pdf-lib abgelehnt oder über Zeit-/Speichergrenze: als geprüft markiert. */
  unreadable: number;
  /** Objekt weicht von Länge/SHA-256 der Version ab: als geprüft markiert. */
  integrity: number;
  /** Version zwischenzeitlich geändert, gezählt oder gesperrt: nichts gespeichert. */
  skipped: number;
  /** Speicher- oder Thread-Fehler: bleibt für den nächsten Lauf offen. */
  failed: number;
  /** Nach dem Lauf weiterhin offene Kandidaten (alle Tenants). */
  backlog: number;
  /** Der Lauf endete am Zeitbudget oder wegen Herunterfahrens. */
  budgetExhausted: boolean;
  /** Der Lauf endete nach MAX_CONSECUTIVE_FAILURES Fehlern in Folge. */
  aborted: boolean;
}

type Totals = Pick<
  PdfPageCountBackfillResult,
  'examined' | 'counted' | 'unreadable' | 'integrity' | 'skipped' | 'failed'
>;
type TenantStop = 'done' | 'budget' | 'aborted';

/** Arbeitet die offenen Kandidaten eines Tenants in Stapeln ab. */
async function processTenant(
  tenantId: string,
  budget: RunBudget,
  totals: Totals,
  streak: { failures: number },
): Promise<TenantStop> {
  let after: string | null = null;
  for (;;) {
    if (budget.exhausted()) return 'budget';
    const cursor: string | null = after;
    const batch: Candidate[] = await withSystemContext(tenantId, (tx) =>
      findCandidatesTx(tx, tenantId, cursor),
    );
    for (const candidate of batch) {
      if (budget.exhausted()) return 'budget';
      const outcome = await processCandidate(tenantId, candidate);
      totals.examined += 1;
      totals[outcome] += 1;
      streak.failures = outcome === 'failed' ? streak.failures + 1 : 0;
      if (streak.failures >= MAX_CONSECUTIVE_FAILURES) return 'aborted';
      after = candidate.documentId;
    }
    // Ein nicht voller Stapel enthielt alle offenen Kandidaten dieses Tenants.
    if (batch.length < PDF_PAGE_COUNT_BATCH_SIZE) return 'done';
  }
}

/**
 * Ein Lauf über alle Tenants (geplanter Job) oder nur über `scope.tenantIds`
 * (gezielter Lauf, Tests).
 */
export async function runPdfPageCountBackfill(
  budget: RunBudget = startRunBudget(),
  scope: { tenantIds?: readonly string[] } = {},
): Promise<PdfPageCountBackfillResult> {
  const totals: Totals = {
    examined: 0,
    counted: 0,
    unreadable: 0,
    integrity: 0,
    skipped: 0,
    failed: 0,
  };
  // S-01: Die mandantenübergreifende Tenant-Liste (nur IDs) liest der Owner-Client;
  // Kandidaten und Ergebnisse laufen je Tenant über die App-Rolle.
  const tenants = await prismaOwner.tenant.findMany({
    where: scope.tenantIds ? { id: { in: [...scope.tenantIds] } } : {},
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const streak = { failures: 0 };
  let stop: TenantStop = 'done';
  for (const { id } of tenants) {
    stop = await processTenant(id, budget, totals, streak);
    if (stop !== 'done') break;
  }
  let backlog = 0;
  for (const { id } of tenants) {
    backlog += await withSystemContext(id, (tx) => countBacklogTx(tx, id));
  }
  const result: PdfPageCountBackfillResult = {
    ...totals,
    backlog,
    budgetExhausted: stop === 'budget',
    aborted: stop === 'aborted',
  };
  const summary = { component: 'pdf-page-count-backfill', ...result };
  if (result.aborted) log.warn(summary, 'pdf-page-count-backfill finished');
  else log.info(summary, 'pdf-page-count-backfill finished');
  return result;
}

// Typ explizit: der Processor liest `closing` des eigenen Workers (P-17).
export const pdfPageCountBackfillWorker: Worker<Record<string, never>> = createWorker<
  Record<string, never>
>(
  JOB_QUEUES.pdfPageCountBackfill.name,
  async () =>
    runPdfPageCountBackfill(
      startRunBudget({ stop: () => isWorkerClosing(pdfPageCountBackfillWorker) }),
    ),
  { connection, concurrency: 1 },
);
