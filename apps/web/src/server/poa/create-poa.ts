// =============================================================================
// Anlage einer Vollmacht (Review-Finding K-03).
//
// Fachkatalog: POA-LIFECYCLE-001, CLIENT-MANDATE-LIFECYCLE-001,
// DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001
//
// R-4 (Berufsträger-Gate ADMIN/PARTNER), Formular-Parsing, Revalidierung und
// Weiterleitung bleiben in der Action. Dieser Service liefert:
//   1. preparePoaCreate — Modulmodus (In-App oder Extern-PDF), vorgemerkter
//      Upload, Pflicht-Umfang; im Extern-Modus Zugriffs-/Lifecycle-Gate und
//      der zweiphasige PDF-Upload (storePoaPdf: PENDING → Object-Write → CLEAN)
//   2. createPoaRecordTx — dieselbe Mandatsprüfung erneut unter Zeilensperre,
//      PDF-Bereitschaft, Anlage als DRAFT und Audit in EINER Transaktion
// =============================================================================

import { withTenantContext, type TxClient } from '@taxtronik/db';
import { MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
import { ActionError, type StaffCtx } from '@/server/actions/staff-action';
import type { StaffSession } from '@/server/auth/staff';
import { readModules } from '@/server/settings/modules';
import {
  persistResumableDocumentUpload,
  ResumableDocumentUploadError,
  ResumableDocumentUploadInvariantError,
  type ResumableDocumentUploadOptions,
} from '@/server/documents/resumable-upload';

/** Geprüfte Formularwerte der Anlage (Leerstring = nicht angegeben). */
export interface PoaCreateInput {
  clientId: string;
  signerContactId?: string;
  signerEmail: string;
  signerName: string;
  subject: string;
  scope?: string;
  validFrom: string;
  validUntil?: string;
  pendingDocumentId?: string;
  uploadIntentId?: string;
}

/** Abgelehnte Anlage; `pendingDocumentId` erlaubt das Fortsetzen eines Uploads. */
export interface PoaCreateFailure {
  ok: false;
  error: string;
  pendingDocumentId?: string;
}

/** Vorbereitete Anlage: Modus, Umfang und im Extern-Modus das gespeicherte PDF. */
export interface PreparedPoaCreate {
  externMode: boolean;
  scope: string;
  pdf: { documentId: string; versionId: string } | null;
}

/**
 * Ergebnis der Vorbereitung. `existingPoaId`: Der Upload-Intent gehört bereits
 * zu einer Vollmacht (wiederholter Aufruf) — die Action leitet dorthin weiter.
 */
export type PoaCreatePreparation =
  | PoaCreateFailure
  | { ok: true; existingPoaId: string; prepared: null }
  | { ok: true; existingPoaId: null; prepared: PreparedPoaCreate };

type PoaPdfStorage =
  | PoaCreateFailure
  | { ok: true; existingPoaId: string; pdf: null }
  | { ok: true; existingPoaId: null; pdf: { documentId: string; versionId: string } };

/**
 * Prueft alle mandatsbezogenen Voraussetzungen, die vor einem unveraenderbaren
 * PDF-Commit sicher feststehen muessen. Beim eigentlichen Insert wird dieselbe
 * Pruefung erneut ausgefuehrt, damit Parallel-Aenderungen nicht unbemerkt
 * zwischen Preflight und Datenbank-Transaktion durchrutschen.
 */
export async function assertPoaCreateContextTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
  signerContactId?: string,
  lockForCreate = false,
): Promise<void> {
  // Explizite Onboarding-IDs duerfen auch vor der finalen Aktivierung
  // verwendet werden, aber niemals RBAC-fremde, beendete oder bereits
  // anonymisierte Mandate. Sonst koennten nach einer DSGVO-Redaktion neue
  // Unterzeichnerdaten am Altmandat entstehen.
  await assertClientAccessTx(tx, session, clientId);
  const eligibleClient = lockForCreate
    ? (
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
            FROM "client"
           WHERE "id" = ${clientId}::uuid
             AND "anonymized_at" IS NULL
             AND "mandate_ended_at" IS NULL
           FOR UPDATE
        `
      )[0]
    : await tx.client.findFirst({
        where: { id: clientId, anonymizedAt: null, mandateEndedAt: null },
        select: { id: true },
      });
  if (!eligibleClient) {
    throw new ActionError(
      'Fuer ein beendetes oder anonymisiertes Mandat kann keine neue Vollmacht angelegt werden.',
    );
  }

  // Ein fremder Kontakt darf weder im Datensatz noch in einem schon vorher
  // gesperrten, danach nicht mehr loeschbaren PDF-Upload landen.
  if (signerContactId) {
    const contact = lockForCreate
      ? (
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
              FROM "client_contact"
             WHERE "id" = ${signerContactId}::uuid
               AND "client_id" = ${clientId}::uuid
             FOR KEY SHARE
          `
        )[0]
      : await tx.clientContact.findFirst({
          where: { id: signerContactId, clientId },
          select: { id: true },
        });
    if (!contact) {
      throw new ActionError('Ansprechpartner gehoert nicht zum gewaehlten Mandanten.');
    }
  }
}

/** Liest das hochgeladene Vollmachts-PDF (Typ und Größe; Inhalt prüft der Upload). */
export async function readPoaPdfBytes(formData: FormData): Promise<Buffer> {
  const file = formData.get('poaPdf');
  if (!(file instanceof File) || file.size === 0) {
    throw new ActionError('Bitte eine PDF-Datei hochladen.');
  }
  if (file.type !== 'application/pdf') {
    throw new ActionError('Nur PDF-Dateien erlaubt.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ActionError(`PDF zu groß (max. ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`);
  }
  return Buffer.from(await file.arrayBuffer());
}

function poaUploadCause(cause: unknown): unknown {
  if (!(cause instanceof ResumableDocumentUploadInvariantError)) return cause;
  switch (cause.code) {
    case 'RESUME_NOT_FOUND':
      return new ActionError('Vorgemerkter PDF-Upload wurde nicht gefunden.');
    case 'RESUME_NOT_RESUMABLE':
      return new ActionError('Vorgemerkter PDF-Upload ist nicht wiederaufnehmbar.');
    case 'RESUME_INVALID_STATUS':
      return new ActionError('Vorgemerkter PDF-Upload hat einen ungültigen Status.');
    case 'TENANT_CONTEXT_MISMATCH':
    case 'PREPARED_TENANT_MISMATCH':
      return new ActionError('Die Upload-Absicht gehört nicht zum aktuellen Mandanten.');
  }
}

function poaUploadErrorResult(error: unknown): PoaCreateFailure {
  if (!(error instanceof ResumableDocumentUploadError)) return toActionError(error);
  const cause = poaUploadCause(error.cause);
  switch (error.phase) {
    case 'prepare':
      if (cause instanceof ActionError) return toActionError(cause);
      return { ok: false, error: `Upload-Prüfung fehlgeschlagen: ${toActionError(cause).error}` };
    case 'resume':
      return { ...toActionError(cause), pendingDocumentId: error.pendingDocumentId };
    case 'journal':
      return toActionError(cause);
    case 'commit':
      return {
        ok: false,
        error:
          'Upload noch nicht abgeschlossen. Sie können den Vorgang mit derselben PDF sicher fortsetzen.',
        pendingDocumentId: error.pendingDocumentId,
      };
    case 'finalize':
      return {
        ok: false,
        error:
          'Das PDF wurde gespeichert, aber noch nicht abschließend zugeordnet. Bitte den Vorgang fortsetzen.',
        pendingDocumentId: error.pendingDocumentId,
      };
  }
}

/**
 * Ein bereits journalisierter PDF-Intent darf bei einem parallelen
 * Modulwechsel nicht still als neue In-App-Vollmacht weiterlaufen. Die
 * stabile ID bleibt in der URL und kann nach Reaktivierung fortgesetzt
 * werden; es entsteht kein zweites, verwaistes Dokument.
 */
async function rejectTrackedUploadIntent(
  g: StaffCtx,
  intentId: string,
): Promise<PoaCreateFailure | null> {
  let trackedIntent: { id: string } | null;
  try {
    trackedIntent = await withTenantContext(g.ctx, (tx) =>
      tx.document.findFirst({
        where: { id: intentId, tenantId: g.tenantId, deletedAt: null },
        select: { id: true },
      }),
    );
  } catch (e) {
    return toActionError(e);
  }
  if (!trackedIntent) return null;
  return {
    ok: false,
    error:
      'Ein PDF-Upload für diese Vollmacht ist bereits vorgemerkt. Bitte den PDF-Modus wieder aktivieren und den Vorgang fortsetzen.',
    pendingDocumentId: trackedIntent.id,
  };
}

/** Upload-Intent (stabile Dokument-ID) und eine daran schon gebundene Vollmacht. */
async function findUploadIntent(
  g: StaffCtx,
  data: PoaCreateInput,
): Promise<{ documentId: string | null; poaId: string | null }> {
  return withTenantContext(g.ctx, async (tx) => {
    const document = await tx.document.findFirst({
      where: { id: data.uploadIntentId, tenantId: g.tenantId },
      select: { id: true },
    });
    if (!document) return { documentId: null, poaId: null };
    const poa = await tx.powerOfAttorney.findFirst({
      where: { tenantId: g.tenantId, clientId: data.clientId, documentId: document.id },
      select: { id: true },
    });
    return { documentId: document.id, poaId: poa?.id ?? null };
  });
}

/** Optionen des zweiphasigen PDF-Uploads (GOBD_CONTRACT, journalisiert, mit Audit). */
function poaPdfUploadOptions(
  g: StaffCtx,
  data: PoaCreateInput,
  resumeDocumentId: string | null,
  readPdf: () => Promise<Buffer>,
): ResumableDocumentUploadOptions {
  const { tenantId, staffId, ctx, session } = g;
  return {
    context: ctx,
    resumeDocumentId,
    documentData: {
      id: data.uploadIntentId || undefined,
      tenantId,
      clientId: data.clientId,
      title: `Vollmacht - ${data.subject}`,
      classification: 'GOBD_CONTRACT',
      mimeType: 'application/pdf',
    },
    resumeWhere: {
      clientId: data.clientId,
      classification: 'GOBD_CONTRACT',
      mimeType: 'application/pdf',
      deletedAt: null,
    },
    createdById: staffId,
    storage: {
      tier: 'GOBD',
      classification: 'GOBD_CONTRACT',
      expectedMime: 'application/pdf',
    },
    readBytes: readPdf,
    validatePrepared(prepared) {
      if (prepared.detectedMime !== 'application/pdf') {
        throw new ActionError('Der Dateiinhalt ist keine gültige PDF-Datei.');
      }
    },
    guardMutationTx: (tx) =>
      assertPoaCreateContextTx(tx, session, data.clientId, data.signerContactId || undefined, true),
    async assertDocumentAvailableTx(tx, documentId) {
      const alreadyUsed = await tx.powerOfAttorney.findFirst({
        where: { tenantId, documentId },
        select: { id: true },
      });
      if (alreadyUsed) {
        throw new ActionError('Das vorgemerkte PDF ist bereits einer Vollmacht zugeordnet.');
      }
    },
    recordPendingTx: (tx, pending) =>
      evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document.upload.pending',
        resourceType: 'document',
        resourceId: pending.documentId,
        after: {
          source: 'power_of_attorney',
          classification: 'GOBD_CONTRACT',
          scanStatus: 'PENDING',
        },
      }),
    recordCompleteTx: (tx, complete) =>
      evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document.upload.complete',
        resourceType: 'document',
        resourceId: complete.documentId,
        after: {
          source: 'power_of_attorney',
          classification: 'GOBD_CONTRACT',
          scanStatus: 'CLEAN',
        },
      }),
  };
}

/**
 * Extern-Modus: Das PDF wird zweiphasig geschrieben. Bucket, Key und Hash
 * stehen zuerst als PENDING in der DB; dadurch kann ein COMPLIANCE-Objekt nie
 * unsichtbar werden, selbst wenn die spätere PoA-Transaktion scheitert.
 */
export async function storePoaPdf(
  g: StaffCtx,
  data: PoaCreateInput,
  readPdf: () => Promise<Buffer>,
): Promise<PoaPdfStorage> {
  if (!data.pendingDocumentId && !data.uploadIntentId) {
    return {
      ok: false,
      error: 'Upload-Absicht fehlt. Bitte die Seite neu laden und erneut versuchen.',
    };
  }
  // Erst Zugriffs- und Lifecycle-Gates, dann der vergleichsweise teure Scan.
  try {
    await withTenantContext(g.ctx, (tx) =>
      assertPoaCreateContextTx(tx, g.session, data.clientId, data.signerContactId || undefined),
    );
  } catch (e) {
    return toActionError(e);
  }

  let existingIntentDocumentId: string | null = null;
  if (!data.pendingDocumentId && data.uploadIntentId) {
    let existing: { documentId: string | null; poaId: string | null };
    try {
      existing = await findUploadIntent(g, data);
    } catch (e) {
      return toActionError(e);
    }
    if (existing.poaId) return { ok: true, existingPoaId: existing.poaId, pdf: null };
    existingIntentDocumentId = existing.documentId;
  }

  const resumeDocumentId = data.pendingDocumentId || existingIntentDocumentId;
  try {
    const upload = await persistResumableDocumentUpload(
      poaPdfUploadOptions(g, data, resumeDocumentId, readPdf),
    );
    return {
      ok: true,
      existingPoaId: null,
      pdf: { documentId: upload.documentId, versionId: upload.versionId },
    };
  } catch (error) {
    return poaUploadErrorResult(error);
  }
}

/**
 * Alles vor der Anlage-Transaktion: Modulmodus, vorgemerkter Upload,
 * Pflicht-Umfang und im Extern-Modus das PDF. `readPdf` wird erst nach den
 * Gates gelesen.
 */
export async function preparePoaCreate(
  g: StaffCtx,
  data: PoaCreateInput,
  readPdf: () => Promise<Buffer>,
): Promise<PoaCreatePreparation> {
  const modules = await readModules(g.ctx);
  if (modules.poaMode === 'OFF') {
    return {
      ok: false,
      error: 'Das Vollmachten-Modul ist deaktiviert.',
      pendingDocumentId: data.pendingDocumentId || undefined,
    };
  }
  const externMode = modules.poaMode === 'PDF_TEMPLATE';

  if (!externMode && (data.pendingDocumentId || data.uploadIntentId)) {
    const tracked = await rejectTrackedUploadIntent(
      g,
      (data.pendingDocumentId || data.uploadIntentId)!,
    );
    if (tracked) return tracked;
  }

  // Scope: Im In-App-Modus (MARKDOWN_OTP) Pflicht (Inline-Text). Im Extern-
  // Modus wird kein Inline-Text gepflegt — das DB-Pflichtfeld bekommt einen
  // Deskriptor, der klar macht, dass die echte Vollmacht als PDF hinterlegt ist.
  const scopeRaw = (data.scope ?? '').trim();
  if (!externMode && !scopeRaw) {
    return { ok: false, error: 'Umfang (Markdown) ist im In-App-Modus Pflicht.' };
  }
  const scope = externMode ? '— Extern als PDF hinterlegt —' : scopeRaw;
  if (!externMode) {
    return { ok: true, existingPoaId: null, prepared: { externMode, scope, pdf: null } };
  }

  const stored = await storePoaPdf(g, data, readPdf);
  if (!stored.ok) return stored;
  if (stored.existingPoaId) {
    return { ok: true, existingPoaId: stored.existingPoaId, prepared: null };
  }
  return { ok: true, existingPoaId: null, prepared: { externMode, scope, pdf: stored.pdf } };
}

/** Das gespeicherte PDF ist vollständig (CLEAN, geschützt, Objektversion) und frei. */
async function assertPoaPdfReadyTx(
  tx: TxClient,
  tenantId: string,
  clientId: string,
  pdf: { documentId: string; versionId: string },
): Promise<void> {
  await tx.$queryRaw`
    SELECT "id" FROM "document"
    WHERE "id" = ${pdf.documentId}::uuid
      AND "tenant_id" = ${tenantId}::uuid
    FOR UPDATE
  `;
  const readyDocument = await tx.document.findFirst({
    where: {
      id: pdf.documentId,
      tenantId,
      clientId,
      classification: 'GOBD_CONTRACT',
      mimeType: 'application/pdf',
      deletedAt: null,
    },
    select: {
      versions: {
        orderBy: { versionNo: 'desc' },
        take: 1,
        select: {
          id: true,
          immutable: true,
          scanStatus: true,
          storageVersionId: true,
        },
      },
    },
  });
  const readyVersion = readyDocument?.versions[0];
  if (
    !readyVersion ||
    readyVersion.id !== pdf.versionId ||
    !readyVersion.immutable ||
    readyVersion.scanStatus !== 'CLEAN' ||
    !readyVersion.storageVersionId?.trim()
  ) {
    throw new ActionError('Das Vollmachts-PDF ist noch nicht vollständig gespeichert.');
  }
  const alreadyUsed = await tx.powerOfAttorney.findFirst({
    where: { tenantId, documentId: pdf.documentId },
    select: { id: true },
  });
  if (alreadyUsed) {
    throw new ActionError('Das Vollmachts-PDF ist bereits einer Vollmacht zugeordnet.');
  }
}

/**
 * Anlage-Transaktion: Mandats- und Kontaktprüfung unter Sperre, PDF-
 * Bereitschaft, Vollmacht als DRAFT, Audit `poa.create`. Liefert die ID.
 */
export async function createPoaRecordTx(
  tx: TxClient,
  { tenantId, staffId, session }: Pick<StaffCtx, 'tenantId' | 'staffId' | 'session'>,
  data: PoaCreateInput,
  { externMode, scope, pdf }: PreparedPoaCreate,
): Promise<string> {
  await assertPoaCreateContextTx(
    tx,
    session,
    data.clientId,
    data.signerContactId || undefined,
    true,
  );
  if (pdf) await assertPoaPdfReadyTx(tx, tenantId, data.clientId, pdf);
  const poa = await tx.powerOfAttorney.create({
    data: {
      tenantId,
      clientId: data.clientId,
      signerContactId: data.signerContactId || null,
      signerEmail: data.signerEmail.toLowerCase(),
      signerName: data.signerName,
      subject: data.subject,
      scope,
      validFrom: new Date(data.validFrom),
      validUntil: data.validUntil ? new Date(data.validUntil) : null,
      status: 'DRAFT',
      createdByStaff: staffId,
      documentId: pdf?.documentId ?? null,
    },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'poa.create',
    resourceType: 'power_of_attorney',
    resourceId: poa.id,
    after: {
      subject: data.subject,
      signerEmail: data.signerEmail,
      externMode,
      withPdf: !!pdf,
    },
  });
  return poa.id;
}

/** Anlage-Transaktion im Tenant-Kontext; Fehler bildet die Action ab. */
export function createPoaRecord(
  g: StaffCtx,
  data: PoaCreateInput,
  prepared: PreparedPoaCreate,
): Promise<string> {
  return withTenantContext(g.ctx, (tx) => createPoaRecordTx(tx, g, data, prepared));
}
