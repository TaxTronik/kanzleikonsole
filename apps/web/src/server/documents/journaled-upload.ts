// =============================================================================
// Journal-first-Orchestrator fuer direkte Uploads (Review-Finding K-06).
//
// Fachkatalog: DOC-UPLOAD-JOURNAL-001, DOC-OBJECT-LOCK-001, DOC-RETENTION-CLASS-001
//
// Ablauf je Upload:
//   1. check('pre')   fachliche Vorpruefung in eigener Transaktion: vorhersehbare
//                     Ablehnungen erzeugen weder Scan noch Journal noch Objekt
//   2. prepare        Bytes lesen, Groesse, Virenscan, SHA-256, fester Schluessel,
//                     Retention (noch kein Object-Write)
//   3. journal        Speicherabsicht vor dem PUT dauerhaft journalisieren
//   4. store          exakt diese Absicht schreiben (bedingter PUT)
//   5. check('post')  dieselbe Pruefung erneut in der Commit-Transaktion, danach
//      + commitTx     Dokument/Version/Audit und der atomare Abschluss der Absicht
//
// Bricht der Prozess zwischen 4 und 5 ab, bleibt die Absicht offen und der
// Cleanup-Worker raeumt das Objekt nach der Sicherheitsfrist versionsgenau auf
// (Object Lock: nach dem Retention-Ende). Scheitert 5, bindet `releaseStorageIntent`
// die Objektversion an die offene Absicht; `compensateStorageCommit` ist nur noch
// Rueckfallebene, wenn die Absicht nicht mehr offen ist.
// =============================================================================

import {
  prepareBytesCommitWithTier,
  type CommitDocumentResult,
  type PreparedBytesCommit,
  type ProtectionTier,
} from '@taxtronik/storage';
import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import {
  journalStorageIntents,
  releaseStorageIntent,
  settleStorageIntentTx,
  storeStorageIntent,
  type StorageIntent,
} from '@/server/documents/storage-intent';

export type JournaledUploadPhase = 'check' | 'prepare' | 'journal' | 'store' | 'commit';

/**
 * Phase, in der der Upload angehalten wurde, mit dem urspruenglichen Fehler.
 * `check`/`prepare`/`journal`: nichts im Object Store. `store`/`commit`: die
 * Speicherabsicht bleibt offen und wird vom Cleanup-Worker abgeschlossen.
 */
export class JournaledUploadError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly phase: JournaledUploadPhase,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : `UPLOAD_${phase.toUpperCase()}_FAILED`);
    this.name = 'JournaledUploadError';
    this.cause = cause;
  }
}

/** Urspruenglicher Fehler eines Uploads (fuer die fachliche Fehlerabbildung). */
export function uploadFailureCause(error: unknown): unknown {
  return error instanceof JournaledUploadError ? error.cause : error;
}

export interface JournaledUploadStorage {
  tier: ProtectionTier;
  classification?: string;
  retentionYears?: number;
  retentionAnchor?: Date;
  /** Nur fuer von der App selbst erzeugte Bytes (kein Nutzer-Upload). */
  skipScan?: boolean;
}

export interface JournaledUploadOptions<TChecked, TResult> {
  context: TenantContext;
  /** Herkunft im Journal, z. B. `staff.document.commit`. */
  source: string;
  /**
   * Gemeinsame Vor- und Nachpruefung des Upload-Typs. `pre` laeuft vor Scan,
   * Journal und Object-Write in einer eigenen Transaktion; `post` erneut in der
   * Commit-Transaktion und erhaelt das Ergebnis der Vorpruefung, um zwischen-
   * zeitliche Aenderungen zu erkennen.
   */
  check: (tx: TxClient, phase: 'pre' | 'post', pre?: TChecked) => Promise<TChecked>;
  /** Wird erst nach der Vorpruefung gelesen (z. B. Multipart-Datei). */
  readBytes: (checked: TChecked) => Promise<Buffer>;
  /** Schutzstufe, Klassifikation und Frist aus dem geprueften Stand. */
  storage: (checked: TChecked) => JournaledUploadStorage;
  /** Nach Scan und Hash, vor Journal und Write (z. B. PDF-Seitenzahl). */
  afterPrepare?: (input: {
    prepared: PreparedBytesCommit;
    bytes: Buffer;
    checked: TChecked;
  }) => void | Promise<void>;
  /** Fachlicher Commit in derselben Transaktion wie Nachpruefung und Abschluss. */
  commitTx: (
    tx: TxClient,
    input: { commit: CommitDocumentResult; checked: TChecked },
  ) => Promise<TResult>;
  /**
   * false: Der Commit hat das Objekt bewusst nicht uebernommen (z. B. ein
   * paralleler Lauf hat gewonnen). Die Absicht bleibt dann fuer den Worker offen.
   */
  referenced?: (result: TResult) => boolean;
}

export interface JournaledUpload<TResult> {
  result: TResult;
  commit: CommitDocumentResult;
  /** false: Objekt wurde nicht uebernommen, die Absicht bleibt fuer den Worker offen. */
  referenced: boolean;
}

export async function runJournaledUpload<TChecked, TResult>(
  options: JournaledUploadOptions<TChecked, TResult>,
): Promise<JournaledUpload<TResult>> {
  const { context } = options;

  let checked: TChecked;
  try {
    checked = await withTenantContext(context, (tx) => options.check(tx, 'pre'));
  } catch (cause) {
    throw new JournaledUploadError('check', cause);
  }

  let bytes: Buffer;
  let prepared: PreparedBytesCommit;
  try {
    bytes = await options.readBytes(checked);
    prepared = await prepareBytesCommitWithTier({
      ...options.storage(checked),
      fileData: bytes,
      tenantId: context.tenantId,
    });
    await options.afterPrepare?.({ prepared, bytes, checked });
  } catch (cause) {
    throw new JournaledUploadError('prepare', cause);
  }

  let intent: StorageIntent;
  try {
    const [journaled] = await journalStorageIntents({
      tenantId: context.tenantId,
      intents: [{ source: options.source, prepared }],
    });
    intent = journaled!;
  } catch (cause) {
    throw new JournaledUploadError('journal', cause);
  }

  let commit: CommitDocumentResult;
  try {
    commit = await storeStorageIntent(intent, bytes);
  } catch (cause) {
    throw new JournaledUploadError('store', cause);
  }

  let outcome: { result: TResult; referenced: boolean };
  try {
    outcome = await withTenantContext(context, async (tx) => {
      const current = await options.check(tx, 'post', checked);
      const result = await options.commitTx(tx, { commit, checked: current });
      const referenced = options.referenced?.(result) ?? true;
      if (referenced) await settleStorageIntentTx(tx, intent, commit);
      return { result, referenced };
    });
  } catch (cause) {
    await releaseStorageIntent({ intent, commit, cause });
    throw new JournaledUploadError('commit', cause);
  }

  if (!outcome.referenced) {
    await releaseStorageIntent({
      intent,
      commit,
      cause: new Error(`${options.source}: Objekt wurde vom fachlichen Commit nicht übernommen.`),
    });
  }
  return { result: outcome.result, commit, referenced: outcome.referenced };
}
