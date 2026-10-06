// =============================================================================
// Vorab-Journal fuer Object-Store-Writes (Review-Finding K-06).
//
// Fachkatalog: DOC-UPLOAD-JOURNAL-001, DOC-OBJECT-LOCK-001
//
// Jeder direkte Upload-Pfad journalisiert seine vorbereitete Speicherabsicht
// (fester Bucket/Key, SHA-256, Groesse, Schutz, Retention) VOR dem PUT im
// Storage-Orphan-Journal (`intent = TRUE`). Die fachliche Commit-Transaktion
// schliesst sie ueber `app.settle_storage_intent` atomar als REFERENCED ab.
// Bricht der Prozess zwischen PUT und DB-Commit ab oder scheitert der Commit,
// bleibt die Absicht offen; der Cleanup-Worker findet sie nach der
// Sicherheitsfrist und prueft Referenz, Objektversion und Retention, bevor er
// versionsgenau loescht oder sie als nie geschrieben (ABSENT) abschliesst.
//
// Journal und Freigabe laufen bewusst ueber die Owner-Verbindung in eigenen
// Transaktionen: Die Absicht muss einen Rollback der Fachtransaktion
// ueberleben, und Portal-/GwG-Akteure sehen das Journal per RLS nicht.
// =============================================================================

import {
  commitPreparedBytes,
  type CommitDocumentResult,
  type PreparedBytesCommit,
} from '@taxtronik/storage';
import type { TxClient } from '@taxtronik/db';
import { prismaOwner } from '@/server/db/prisma-owner';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { log } from '@/server/logger';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';

/** Eine vor dem Object-Write dauerhaft journalisierte Speicherabsicht. */
export interface StorageIntent {
  id: string;
  tenantId: string;
  source: string;
  prepared: PreparedBytesCommit;
}

/**
 * JOURNALED: Absicht bleibt offen (Version gebunden), der Worker raeumt auf.
 * COMPENSATED: Absicht war nicht mehr offen; das Objekt wurde nachgelagert
 * journalisiert. LOG_ONLY: nur strukturiertes Betriebslog.
 */
export type StorageIntentRelease = 'JOURNALED' | 'COMPENSATED' | 'LOG_ONLY';

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2000);
}

function assertIntentIdentity(tenantId: string, prepared: PreparedBytesCommit): void {
  // Defense in Depth: Die Absicht darf nur den eigenen Tenant-Praefix belegen;
  // der Worker wuerde einen fremden Praefix ohnehin als Integritaetsvorfall
  // behandeln, statt zu loeschen.
  if (prepared.tenantId !== tenantId || !prepared.targetKey.startsWith(`tenants/${tenantId}/`)) {
    throw new Error('STORAGE_INTENT_TENANT_MISMATCH: Speicherabsicht passt nicht zum Mandanten.');
  }
}

/**
 * Journalisiert die vorbereiteten Absichten atomar (eine Owner-Transaktion),
 * z. B. PDF und XML eines Rechnungsarchivs gemeinsam. Scheitert das Journal,
 * darf der Aufrufer nichts in den Object Store schreiben.
 */
export async function journalStorageIntents(input: {
  tenantId: string;
  intents: ReadonlyArray<{ source: string; prepared: PreparedBytesCommit }>;
}): Promise<StorageIntent[]> {
  for (const { prepared } of input.intents) assertIntentIdentity(input.tenantId, prepared);
  const rows = await prismaOwner.$transaction(
    input.intents.map(({ source, prepared }) =>
      prismaOwner.storageOrphan.create({
        data: {
          tenantId: input.tenantId,
          source,
          intent: true,
          storageBucket: prepared.targetBucket,
          storageKey: prepared.targetKey,
          storageVersionId: '',
          sha256: prismaBytes(prepared.sha256),
          sizeBytes: prepared.sizeBytes,
          immutable: prepared.immutable,
          retentionUntil: prepared.retentionUntil,
        },
        select: { id: true },
      }),
    ),
  );
  return rows.map((row, index) => ({
    id: row.id,
    tenantId: input.tenantId,
    source: input.intents[index]!.source,
    prepared: input.intents[index]!.prepared,
  }));
}

/**
 * Schreibt exakt die journalisierte Absicht (bedingter PUT, Hash-/Groessen-
 * pruefung in `commitPreparedBytes`). Ein Fehler laesst die Absicht offen und
 * vermerkt ihn: Ein verlorener PUT kann serverseitig gelandet sein; erst der
 * Worker entscheidet nach der Sicherheitsfrist.
 */
export async function storeStorageIntent(
  intent: StorageIntent,
  fileData: Buffer,
): Promise<CommitDocumentResult> {
  try {
    return await commitPreparedBytes({ fileData, prepared: intent.prepared });
  } catch (error) {
    try {
      await prismaOwner.storageOrphan.updateMany({
        where: { id: intent.id, intent: true, cleanedAt: null, storageVersionId: '' },
        data: { failure: errorMessage(error) },
      });
    } catch (journalError) {
      log.error(
        {
          component: 'storage-intent',
          intentId: intent.id,
          tenantId: intent.tenantId,
          source: intent.source,
          journalError: errorMessage(journalError),
        },
        'storage intent failure could not be noted; intent stays open',
      );
    }
    throw error;
  }
}

/**
 * Schliesst die Absicht in der fachlichen Commit-Transaktion ab. Die
 * DB-Funktion verlangt eine DocumentVersion desselben Tenants mit genau dieser
 * Speicheridentitaet und eine noch offene, unbeanspruchte Absicht; sonst wirft
 * sie und die Fachtransaktion rollt zurueck. Ihre Zeilensperre haelt einen
 * parallelen Worker-Claim bis zum Commit auf.
 */
export async function settleStorageIntentTx(
  tx: TxClient,
  intent: StorageIntent,
  commit: CommitDocumentResult,
): Promise<void> {
  if (
    commit.targetBucket !== intent.prepared.targetBucket ||
    commit.targetKey !== intent.prepared.targetKey
  ) {
    throw new Error('STORAGE_INTENT_MISMATCH: Objekt gehoert nicht zur Speicherabsicht.');
  }
  await tx.$executeRaw`
    SELECT app.settle_storage_intent(
      ${intent.id}::uuid,
      ${commit.targetBucket},
      ${commit.targetKey},
      ${commit.storageVersionId ?? ''}
    )
  `;
}

/**
 * Laesst eine Absicht nach gescheitertem oder verworfenem Commit offen und
 * bindet die bekannte Objektversion. Der Worker loescht nach der
 * Sicherheitsfrist versionsgenau (Object Lock: erst nach Retention-Ende).
 *
 * Rueckfallebene: Ist die Absicht nicht mehr offen (etwa weil der Worker sie
 * nach einem extrem verzoegerten Commit bereits abgeschlossen hat oder ein
 * Commit-ACK verloren ging), journalisiert `compensateStorageCommit` das Objekt
 * nachgelagert; der Worker prueft dort erneut auf Referenzen.
 */
export async function releaseStorageIntent(input: {
  intent: StorageIntent;
  commit: CommitDocumentResult;
  cause: unknown;
}): Promise<StorageIntentRelease> {
  const { intent, commit, cause } = input;
  const failure = errorMessage(cause);
  const storageVersionId = commit.storageVersionId ?? '';
  const identity = {
    component: 'storage-intent',
    intentId: intent.id,
    tenantId: intent.tenantId,
    source: intent.source,
    storageBucket: intent.prepared.targetBucket,
    storageKey: intent.prepared.targetKey,
    storageVersionId: commit.storageVersionId,
    immutable: intent.prepared.immutable,
    retentionUntil: intent.prepared.retentionUntil?.toISOString() ?? null,
  };
  let updated: { count: number };
  try {
    updated = await prismaOwner.storageOrphan.updateMany({
      where: {
        id: intent.id,
        intent: true,
        cleanedAt: null,
        storageBucket: commit.targetBucket,
        storageKey: commit.targetKey,
        storageVersionId: { in: ['', storageVersionId] },
      },
      data: { storageVersionId, failure },
    });
  } catch (journalError) {
    // Die Absicht steht bereits vor dem Write im Journal; der Worker findet
    // sie auch ohne gebundene Version (Recovery ueber Hash und Groesse).
    log.error(
      {
        ...identity,
        sha256: intent.prepared.sha256.toString('hex'),
        sizeBytes: intent.prepared.sizeBytes.toString(),
        dbFailure: failure,
        journalError: errorMessage(journalError),
      },
      'storage intent could not be updated; worker reconciles the open intent',
    );
    return 'LOG_ONLY';
  }
  if (updated.count === 1) {
    log.warn({ ...identity, failure }, 'storage intent kept open for delayed reconciliation');
    return 'JOURNALED';
  }
  const disposition = await compensateStorageCommit({
    tenantId: intent.tenantId,
    source: intent.source,
    commit,
    cause,
  });
  return disposition === 'JOURNALED' ? 'COMPENSATED' : 'LOG_ONLY';
}
