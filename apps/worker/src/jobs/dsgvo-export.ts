// =============================================================================
// dsgvo-export — DSGVO-Auskunft (Art. 15/20) eines Mandantenkontakts im Worker
//
// Fachkatalog: DSGVO-CONTACT-EXPORT-001, DSGVO-REQUEST-EVIDENCE-001
//
// Welle 15 (Folgepunkt P-11): Die Erzeugung lief in einer 15-s-Transaktion des
// Webprozesses und wuchs linear mit dem Audit-Log. Die Web-App legt jetzt nur
// den Auftrag (dsgvo_export, REQUESTED) an und stößt diesen Job an. Ablauf:
//   1. Auftrag übernehmen (RUNNING, Versuchszähler).
//   2. Paket bauen: derselbe Paketaufbau wie bisher
//      (@taxtronik/db/dsgvo-contact-export), App-Rolle im SYSTEM-Kontext des
//      Tenants (RLS), mit längerem Transaktionslimit als im Webprozess.
//   3. Ziel im Object Store festlegen und im Auftrag vermerken, dann exakt diese
//      Bytes schreiben (bedingter PUT, Größe und SHA-256 geprüft).
//   4. Abschluss in einer Transaktion: Antrag noch offen? Ergebnis-Hash wie
//      bisher am Antrag (frühere personelle Prüfung zurückgesetzt, RECEIVED →
//      IN_PROGRESS), Auftrag DONE mit Objektversion, Audit dsgvo.export.contact
//      wie bisher im Namen der anfordernden Person.
//   5. Überholte Pakete desselben Antrags im Object Store löschen.
// Jeder Fehler endet als FAILED mit Meldung; der Job wird nicht wiederholt, die
// Oberfläche fordert neu an.
//
// RLS-Sicht: Der SYSTEM-Kontext sieht für die abgefragten Tabellen dieselben
// Zeilen wie die bisher anfordernde ADMIN/PARTNER-Rolle (Lohnakten-Sperre und
// Mandatsartefakte lassen beide zu). S-01: kein Owner-Client.
// =============================================================================

import { JOB_QUEUES, type DsgvoExportJob } from '@taxtronik/config/job-queues';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import {
  buildDsgvoContactExport,
  DsgvoContactExportError,
  serializeDsgvoExport,
} from '@taxtronik/db/dsgvo-contact-export';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import {
  commitPreparedBytes,
  deleteObject,
  deleteObjectVersion,
  prepareBytesCommitWithTier,
  UploadRejectedError,
  type CommitDocumentResult,
  type PreparedBytesCommit,
} from '@taxtronik/storage';
import { createWorker } from '../worker-factory';
import { connection } from '../queues';
import { log } from '../logger';

/**
 * Transaktionslimit des Paketaufbaus. Im Webprozess galten 15 s
 * (TX_OPTIONS); je Anweisung bleibt der statement_timeout des App-Pools.
 */
export const DSGVO_EXPORT_BUILD_TX_OPTIONS = { timeout: 120_000, maxWait: 5_000 } as const;

const OPEN_REQUEST_STATUSES = ['RECEIVED', 'IN_PROGRESS'] as const;

/** Meldung für Fehler ohne fachliche Ursache (Details nur im Worker-Log). */
export const DSGVO_EXPORT_GENERIC_ERROR =
  'Das Paket konnte nicht erzeugt werden. Details stehen im Worker-Log; bitte erneut anfordern.';

type TxOptions = { timeout: number; maxWait: number };

export interface DsgvoExportDeps {
  /** Transaktion der App-Rolle im SYSTEM-Kontext des Tenants (RLS). */
  inSystemContext<T>(
    tenantId: string,
    fn: (tx: TxClient) => Promise<T>,
    options?: TxOptions,
  ): Promise<T>;
  build: typeof buildDsgvoContactExport;
  prepare(input: { fileData: Buffer; tenantId: string }): Promise<PreparedBytesCommit>;
  commit(input: { fileData: Buffer; prepared: PreparedBytesCommit }): Promise<CommitDocumentResult>;
  deleteStored(ref: { bucket: string; key: string; versionId: string | null }): Promise<void>;
  record: EvidenceService['record'];
  now(): Date;
}

export type DsgvoExportOutcome = 'DONE' | 'FAILED' | 'SKIPPED';

function failureMessage(error: unknown): string {
  if (error instanceof DsgvoContactExportError || error instanceof UploadRejectedError) {
    return error.message.slice(0, 2000);
  }
  return DSGVO_EXPORT_GENERIC_ERROR;
}

async function deleteQuietly(
  deps: DsgvoExportDeps,
  ref: { bucket: string; key: string; versionId: string | null },
  exportId: string,
): Promise<boolean> {
  try {
    await deps.deleteStored(ref);
    return true;
  } catch (error) {
    log.warn(
      {
        component: 'dsgvo-export',
        exportId,
        bucket: ref.bucket,
        key: ref.key,
        err: error instanceof Error ? error.message : String(error),
      },
      'dsgvo-export: Paketobjekt nicht gelöscht; Schlüssel steht im Auftrag',
    );
    return false;
  }
}

export async function processDsgvoExport(
  job: DsgvoExportJob,
  deps: DsgvoExportDeps,
): Promise<DsgvoExportOutcome> {
  const { tenantId, exportId } = job;

  // 1. Übernehmen. RUNNING → RUNNING: Wiederaufnahme nach einem abgebrochenen
  // Lauf (BullMQ stellt einen hängengebliebenen Job einmal neu zu).
  const claimed = await deps.inSystemContext(tenantId, async (tx) => {
    const current = await tx.dsgvoExport.findFirst({
      where: { id: exportId, tenantId, status: { in: ['REQUESTED', 'RUNNING'] } },
    });
    if (!current) return null;
    if (current.storageKey) {
      // Ein früherer Versuch hat sein Ziel vermerkt und brach danach ab.
      log.warn(
        {
          component: 'dsgvo-export',
          exportId,
          bucket: current.storageBucket,
          key: current.storageKey,
        },
        'dsgvo-export: abgebrochener Versuch hinterließ ein Objektziel',
      );
    }
    return tx.dsgvoExport.update({
      where: { id: exportId },
      data: {
        status: 'RUNNING',
        startedAt: deps.now(),
        attempts: { increment: 1 },
        storageBucket: null,
        storageKey: null,
        storageVersionId: null,
      },
    });
  });
  if (!claimed) return 'SKIPPED';

  let stored: CommitDocumentResult | null = null;
  const fail = async (error: unknown): Promise<DsgvoExportOutcome> => {
    if (!(error instanceof DsgvoContactExportError)) {
      log.error(
        {
          component: 'dsgvo-export',
          exportId,
          err: error instanceof Error ? error.message : String(error),
          errName: error instanceof Error ? error.name : undefined,
        },
        'dsgvo-export: Paket nicht erzeugt',
      );
    }
    if (stored) {
      await deleteQuietly(
        deps,
        { bucket: stored.targetBucket, key: stored.targetKey, versionId: stored.storageVersionId },
        exportId,
      );
    }
    await deps.inSystemContext(tenantId, (tx) =>
      tx.dsgvoExport.updateMany({
        where: { id: exportId, status: { in: ['REQUESTED', 'RUNNING'] } },
        data: { status: 'FAILED', finishedAt: deps.now(), error: failureMessage(error) },
      }),
    );
    return 'FAILED';
  };

  try {
    // 2. Paket bauen (gleicher Inhalt und gleiches Format wie bisher).
    const generatedAt = deps.now();
    const built = await deps.inSystemContext(
      tenantId,
      (tx) =>
        deps.build(tx, {
          tenantId,
          requestId: claimed.requestId,
          contactId: claimed.contactId,
          exportedBy: claimed.requestedBy,
          generatedAt,
        }),
      DSGVO_EXPORT_BUILD_TX_OPTIONS,
    );
    if (built.contact.id !== claimed.contactId || built.request.id !== claimed.requestId) {
      throw new Error('dsgvo-export: Paket gehört nicht zum Auftrag.');
    }
    const { serialized, sha256 } = serializeDsgvoExport(built.exportData);
    const fileData = Buffer.from(serialized, 'utf8');

    // 3. Ziel vermerken, dann exakt diese Bytes schreiben.
    const prepared = await deps.prepare({ fileData, tenantId });
    await deps.inSystemContext(tenantId, (tx) =>
      tx.dsgvoExport.update({
        where: { id: exportId },
        data: { storageBucket: prepared.targetBucket, storageKey: prepared.targetKey },
      }),
    );
    stored = await deps.commit({ fileData, prepared });
    const committed = stored;

    // 4. Abschluss: Ergebnis am Antrag, Auftrag DONE, Audit wie bisher.
    const superseded = await deps.inSystemContext(tenantId, async (tx) => {
      const [request] = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status::text AS status FROM dsgvo_request
         WHERE id = ${claimed.requestId}::uuid
         FOR UPDATE
      `;
      if (!request || !(OPEN_REQUEST_STATUSES as readonly string[]).includes(request.status)) {
        throw new DsgvoContactExportError(
          'REQUEST_NOT_OPEN',
          'Der DSGVO-Antrag wurde zwischenzeitlich abgeschlossen; das Paket wurde verworfen.',
        );
      }
      const finishedAt = deps.now();
      await tx.dsgvoRequest.update({
        where: { id: claimed.requestId },
        data: {
          resultSha256: new Uint8Array(sha256),
          resultPreparedAt: generatedAt,
          resultPreparedBy: claimed.requestedBy,
          // Jede Neugenerierung verändert das Paket und braucht eine neue
          // personelle Vollständigkeitsprüfung.
          resultReviewedAt: null,
          resultReviewedBy: null,
          ...(request.status === 'RECEIVED' ? { status: 'IN_PROGRESS' as const } : {}),
        },
      });
      await tx.dsgvoExport.update({
        where: { id: exportId },
        data: {
          status: 'DONE',
          finishedAt,
          sha256: new Uint8Array(sha256),
          sizeBytes: BigInt(fileData.length),
          storageBucket: committed.targetBucket,
          storageKey: committed.targetKey,
          storageVersionId: committed.storageVersionId,
        },
      });
      await deps.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: claimed.requestedBy,
        action: 'dsgvo.export.contact',
        resourceType: 'dsgvo_request',
        resourceId: claimed.requestId,
        after: {
          exportedFor: built.contact.email,
          contactId: built.contact.id,
          sha256: sha256.toString('hex'),
          manualReviewRequired: true,
          exportId,
        },
      });
      return tx.dsgvoExport.findMany({
        where: {
          requestId: claimed.requestId,
          status: 'DONE',
          id: { not: exportId },
          objectDeletedAt: null,
        },
        select: { id: true, storageBucket: true, storageKey: true, storageVersionId: true },
      });
    });
    stored = null;
    await deleteSuperseded(deps, tenantId, superseded);
    return 'DONE';
  } catch (error) {
    return fail(error);
  }
}

/** 5. Überholte Pakete löschen; sie sind nicht mehr das Ergebnis des Antrags. */
async function deleteSuperseded(
  deps: DsgvoExportDeps,
  tenantId: string,
  superseded: ReadonlyArray<{
    id: string;
    storageBucket: string | null;
    storageKey: string | null;
    storageVersionId: string | null;
  }>,
): Promise<void> {
  for (const old of superseded) {
    if (!old.storageBucket || !old.storageKey) continue;
    const deleted = await deleteQuietly(
      deps,
      { bucket: old.storageBucket, key: old.storageKey, versionId: old.storageVersionId },
      old.id,
    );
    if (!deleted) continue;
    try {
      await deps.inSystemContext(tenantId, (tx) =>
        tx.dsgvoExport.update({ where: { id: old.id }, data: { objectDeletedAt: deps.now() } }),
      );
    } catch (error) {
      log.warn(
        {
          component: 'dsgvo-export',
          exportId: old.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'dsgvo-export: Löschvermerk für überholtes Paket nicht gespeichert',
      );
    }
  }
}

const evidence = new EvidenceService(new LocalTimestampAdapter());

export function dsgvoExportDeps(): DsgvoExportDeps {
  return {
    inSystemContext: (tenantId, fn, options) =>
      withTenantContext({ tenantId, actorId: null, actorType: 'SYSTEM' }, fn, options),
    build: buildDsgvoContactExport,
    // App-eigene Bytes (kein Upload): ohne Virenscan, ohne Object Lock (Stufe
    // NONE) — überholte Pakete werden gelöscht.
    prepare: ({ fileData, tenantId }) =>
      prepareBytesCommitWithTier({ fileData, tier: 'NONE', tenantId, skipScan: true }),
    commit: (input) => commitPreparedBytes(input),
    deleteStored: ({ bucket, key, versionId }) =>
      versionId ? deleteObjectVersion(bucket, key, versionId) : deleteObject(bucket, key),
    record: (tx, event) => evidence.record(tx, event),
    now: () => new Date(),
  };
}

export const dsgvoExportWorker = createWorker<DsgvoExportJob>(
  JOB_QUEUES.dsgvoExport.name,
  async (job) => {
    const outcome = await processDsgvoExport(job.data, dsgvoExportDeps());
    log.info({ exportId: job.data.exportId, outcome }, 'dsgvo-export: done');
    return { outcome };
  },
  { connection, concurrency: 1 },
);
