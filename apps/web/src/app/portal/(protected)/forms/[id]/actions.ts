'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { commitDocumentFromBytes, deleteObject, deleteObjectVersion } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { emitN8nEvent } from '@/server/n8n/emit';
import { checkRateLimit, checkPortalWriteLimit } from '@/server/rate-limit';
import { assertPortalFeature } from '@/server/settings/portal-features';
import { toActionError } from '@/server/auth/rbac';
import { portalActionGuard, ActionError, type ActionResult } from '@/server/actions/portal-action';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';
import { validateFormAnswers } from '@/server/forms/validate-answers';

const Schema = z.object({
  submissionId: z.string().uuid(),
  answers: z
    .record(z.string().min(1).max(60), z.unknown())
    .refine((answers) => Object.keys(answers).length <= 200, 'Zu viele Formularfelder.')
    .refine((answers) => {
      try {
        return JSON.stringify(answers).length <= 1_000_000;
      } catch {
        return false;
      }
    }, 'Formularantworten sind zu groß.'),
});

async function loadSubmissionAndCheckTx(tx: TxClient, submissionId: string, clientId: string) {
  // Die Submission selbst ist die gemeinsame Serialisierungsgrenze für
  // Draft, Upload, Verwerfen und Submit. Nicht jede Submission besitzt einen
  // Request; ein reiner Request-Lock ließ deshalb Upload/Submit-Rennen offen.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
      FROM "form_submission"
     WHERE id = ${submissionId}::uuid
       AND client_id = ${clientId}::uuid
     FOR UPDATE
  `;
  if (locked.length === 0) throw new ActionError('Formular nicht gefunden.');

  const sub = await tx.formSubmission.findUnique({
    where: { id: submissionId },
    include: {
      template: { include: { fields: { orderBy: { position: 'asc' } } } },
    },
  });
  if (!sub || sub.clientId !== clientId) throw new ActionError('Formular nicht gefunden.');
  if (sub.status === 'SUBMITTED' || sub.status === 'REVIEWED') {
    throw new ActionError('Formular wurde bereits übermittelt.');
  }

  // Der Request ist der fachliche Portal-Lifecycle. Wir sperren seine Zeile
  // bis zum Ende dieser Transaktion, damit ein paralleles Kanzlei-Close nicht
  // zwischen Statusprüfung und Draft/Submit vorbeilaufen kann. Der Fallback
  // über formSubmissionId hält ältere Datensätze ohne requestId-Rücklink dicht.
  const candidates = await tx.request.findMany({
    where: sub.requestId
      ? { id: sub.requestId, tenantId: sub.tenantId, clientId }
      : { tenantId: sub.tenantId, clientId, formSubmissionId: sub.id },
    select: { id: true, status: true },
    orderBy: { id: 'asc' },
  });
  if (sub.requestId && candidates.length !== 1) {
    throw new ActionError('Diese Anforderung ist abgeschlossen. Das Formular ist gesperrt.');
  }
  const linkedRequests: Array<{ id: string; status: string }> = [];
  for (const candidate of candidates) {
    // Fallback-Bestände können mehrere Requests auf dieselbe Submission
    // zeigen. Alle in stabiler Reihenfolge sperren und fail-closed prüfen;
    // ein beliebiges findFirst würde bei OPEN+CLOSED nondeterministisch
    // Schreibzugriff erlauben.
    await tx.$queryRaw`SELECT id FROM "request" WHERE id = ${candidate.id}::uuid FOR UPDATE`;
    const fresh = await tx.request.findFirst({
      where: { id: candidate.id, tenantId: sub.tenantId, clientId },
      select: { id: true, status: true },
    });
    if (!fresh || !['OPEN', 'IN_PROGRESS'].includes(fresh.status)) {
      throw new ActionError('Diese Anforderung ist abgeschlossen. Das Formular ist gesperrt.');
    }
    linkedRequests.push(fresh);
  }
  return { ...sub, linkedRequests };
}

async function validateAnswersTx(
  tx: TxClient,
  sub: Awaited<ReturnType<typeof loadSubmissionAndCheckTx>>,
  answers: Record<string, unknown>,
  clientId: string,
  requireRequired: boolean,
): Promise<void> {
  let validated: ReturnType<typeof validateFormAnswers>;
  try {
    validated = validateFormAnswers(sub.template.fields, answers, { requireRequired });
  } catch (error) {
    throw new ActionError(error instanceof Error ? error.message : 'Ungültige Formularantworten.');
  }
  // Nicht nur die vom Browser gelieferten Referenzen prüfen: Ein staler Tab
  // könnte sonst einen bereits gebundenen Upload aus `answers` weglassen und
  // damit ein nach Submit dauerhaft unerreichbares Dokument hinterlassen.
  // Alle lebenden Uploads dieser Submission müssen exakt 1:1 (Feld, UUID und
  // kanonischer Dateiname) im Payload vorkommen. Entfernen ist ausschließlich
  // über discardFormFileAction erlaubt.
  const documents = await tx.document.findMany({
    where: {
      tenantId: sub.tenantId,
      clientId,
      deletedAt: null,
      formSubmissionId: sub.id,
    },
    select: { id: true, title: true, formFieldKey: true },
  });
  if (documents.length !== validated.fileReferences.length) {
    throw new ActionError(
      'Formulardateien wurden zwischenzeitlich geändert. Bitte laden Sie das Formular neu.',
    );
  }
  const referencesByField = new Map(
    validated.fileReferences.map((reference) => [reference.fieldKey, reference]),
  );
  for (const document of documents) {
    const reference = document.formFieldKey
      ? referencesByField.get(document.formFieldKey)
      : undefined;
    if (
      !reference ||
      reference.documentId !== document.id ||
      reference.fileName !== document.title
    ) {
      throw new ActionError(
        'Formulardateien wurden zwischenzeitlich geändert. Bitte laden Sie das Formular neu.',
      );
    }
  }
}

export async function saveSubmissionDraftAction(
  input: z.infer<typeof Schema>,
): Promise<ActionResult> {
  const g = await portalActionGuard({ module: 'forms' });
  if (!g.ok) return g;
  const { contactId, clientId, ctx } = g;

  // S4: globaler Portal-Schreib-Backstop. Drafts können jede Sekunde aktualisiert
  // werden — Spam-Schutz gegen exzessive Schreiblast.
  const rl = await checkPortalWriteLimit(contactId);
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Aktionen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }
  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  try {
    await withTenantContext(ctx, async (tx) => {
      const sub = await loadSubmissionAndCheckTx(tx, parsed.data.submissionId, clientId);
      await validateAnswersTx(tx, sub, parsed.data.answers, clientId, false);
      const saved = await tx.formSubmission.updateMany({
        where: {
          id: parsed.data.submissionId,
          clientId,
          status: { in: ['PENDING', 'DRAFT'] },
        },
        data: {
          answers: parsed.data.answers as Prisma.InputJsonValue,
          status: 'DRAFT',
        },
      });
      if (saved.count === 0) {
        throw new ActionError('Formular wurde bereits übermittelt.');
      }
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath(`/portal/forms/${parsed.data.submissionId}`);
  return { ok: true };
}

export async function submitSubmissionAction(input: z.infer<typeof Schema>): Promise<ActionResult> {
  const g = await portalActionGuard({ module: 'forms' });
  if (!g.ok) return g;
  const { tenantId, contactId, clientId, ctx } = g;

  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  let linkedRequestIds: string[];
  try {
    linkedRequestIds = await withTenantContext(ctx, async (tx) => {
      const sub = await loadSubmissionAndCheckTx(tx, parsed.data.submissionId, clientId);
      // Typen, Optionen, Grenzen und Pflichtfelder werden innerhalb derselben
      // Transaktion wie der atomare Statuswechsel geprüft.
      await validateAnswersTx(tx, sub, parsed.data.answers, clientId, true);

      const submitted = await tx.formSubmission.updateMany({
        where: {
          id: parsed.data.submissionId,
          clientId,
          status: { in: ['PENDING', 'DRAFT'] },
        },
        data: {
          answers: parsed.data.answers as Prisma.InputJsonValue,
          status: 'SUBMITTED',
          submittedAt: new Date(),
          submittedByContact: contactId,
        },
      });
      if (submitted.count === 0) {
        throw new ActionError('Formular wurde bereits übermittelt.');
      }

      // Die Formularabgabe erfüllt den mandantenseitigen offenen Vorgang.
      // RESPONDED (statt CLOSED) hält die fachliche Nachbearbeitung und
      // Kanzlei-Zusammenarbeit offen, entfernt die Anforderung aber aus den
      // offenen Mandanten-/Reminder-Flows. Fallback über formSubmissionId
      // deckt ältere Workflow-Submissions ohne requestId-Rücklink ab.
      const linkedRequests = sub.linkedRequests;
      if (linkedRequests.length > 0) {
        const responded = await tx.request.updateMany({
          where: {
            id: { in: linkedRequests.map((request) => request.id) },
            tenantId,
            clientId,
            status: { in: ['OPEN', 'IN_PROGRESS'] },
          },
          data: { status: 'RESPONDED' },
        });
        if (responded.count !== linkedRequests.length) {
          throw new ActionError('Eine verknüpfte Anforderung wurde zwischenzeitlich geändert.');
        }
        for (const linkedRequest of linkedRequests) {
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'CLIENT_CONTACT',
            actorId: contactId,
            action: 'request.responded',
            resourceType: 'request',
            resourceId: linkedRequest.id,
            before: { status: linkedRequest.status },
            after: {
              status: 'RESPONDED',
              source: 'FORM_SUBMISSION',
              formSubmissionId: sub.id,
            },
          });
        }
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'form.submission.submit',
        resourceType: 'form_submission',
        resourceId: parsed.data.submissionId,
        after: { fieldCount: sub.template.fields.length },
      });
      return linkedRequests.map((request) => request.id);
    });
  } catch (e) {
    return toActionError(e);
  }

  const eventRequestIds: Array<string | null> =
    linkedRequestIds.length > 0 ? linkedRequestIds : [null];
  for (const requestId of eventRequestIds) {
    await emitN8nEvent(
      'request.responded',
      {
        tenantId,
        formSubmissionId: parsed.data.submissionId,
        clientId,
        requestId,
      },
      { tenantId },
    );
  }

  revalidatePath(`/portal/forms/${parsed.data.submissionId}`);
  revalidatePath('/portal/forms');
  for (const requestId of linkedRequestIds) revalidatePath(`/portal/requests/${requestId}`);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// FILE-Feld-Upload (Mandant lädt Datei zu einem konkreten Feld einer Submission)
// ----------------------------------------------------------------------------

const UploadSchema = z.object({
  submissionId: z.string().uuid(),
  fieldKey: z.string().min(1).max(60),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  base64: z
    .string()
    .min(1)
    .max(20 * 1024 * 1024),
});

export async function uploadFormFileAction(input: {
  submissionId: string;
  fieldKey: string;
  fileName: string;
  mimeType: string;
  base64: string;
}): Promise<ActionResult & { documentId?: string }> {
  const g = await portalActionGuard({ module: 'forms' });
  if (!g.ok) return g;
  const { tenantId, contactId, clientId, ctx } = g;

  const parsed = UploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // F2: Feature-Flag-Guard — Form-Datei-Uploads erzeugen Document-Reihen wie
  // der Portal-Upload-Pfad. Gleicher documentUpload-Flag.
  try {
    await assertPortalFeature(ctx, 'documentUpload');
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // NEW2: Rate-Limit pro Contact + pro Submission. Schließt Storage-/ClamAV-
  // Sättigung durch authentifizierte Portal-User analog zur GwG-Onboarding-
  // Lücke (H2).
  const contactRl = await checkRateLimit(`forms-upload-contact:${contactId}`, {
    max: 20,
    windowSec: 600,
  });
  if (!contactRl.ok) {
    return {
      ok: false,
      error: `Zu viele Uploads. Bitte ${Math.ceil(contactRl.retryAfter / 60)} Min. warten.`,
    };
  }
  const subRl = await checkRateLimit(`forms-upload-sub:${parsed.data.submissionId}`, {
    max: 30,
    windowSec: 600,
  });
  if (!subRl.ok) {
    return { ok: false, error: 'Zu viele Uploads für dieses Formular.' };
  }

  let documentId: string;
  let stored: Awaited<ReturnType<typeof commitDocumentFromBytes>> | null = null;
  try {
    const sub = await withTenantContext(ctx, (tx) =>
      loadSubmissionAndCheckTx(tx, parsed.data.submissionId, clientId),
    );
    // Prüfen, dass das Feld existiert und vom Typ FILE ist
    const field = sub.template.fields.find((f) => f.key === parsed.data.fieldKey);
    if (!field) return { ok: false, error: 'Unbekanntes Feld.' };
    if (field.type !== 'FILE') return { ok: false, error: 'Feld erwartet keinen Datei-Upload.' };

    const fileData = Buffer.from(parsed.data.base64, 'base64');
    if (fileData.length > 10 * 1024 * 1024) {
      return { ok: false, error: 'Datei zu groß (max. 10 MB).' };
    }

    const committed = await commitDocumentFromBytes({
      fileData,
      classification: 'GENERAL',
      tenantId,
    });
    stored = committed;

    documentId = await withTenantContext(ctx, async (tx) => {
      // Storage liegt bewusst außerhalb der DB-Transaktion. Deshalb Status und
      // Feld nach dem Upload noch einmal prüfen; bei zwischenzeitigem Close
      // greift unten die Storage-Kompensation.
      const currentSub = await loadSubmissionAndCheckTx(tx, parsed.data.submissionId, clientId);
      const currentField = currentSub.template.fields.find(
        (field) => field.key === parsed.data.fieldKey,
      );
      if (currentField?.type !== 'FILE') {
        throw new ActionError('Feld erwartet keinen Datei-Upload.');
      }
      const existingFieldUpload = await tx.document.findFirst({
        where: {
          tenantId,
          clientId,
          formSubmissionId: currentSub.id,
          formFieldKey: currentField.key,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (existingFieldUpload) {
        throw new ActionError(
          'Für dieses Feld wurde bereits eine Datei hochgeladen. Bitte entfernen Sie diese zuerst.',
        );
      }
      const doc = await tx.document.create({
        data: {
          tenantId,
          clientId,
          title: parsed.data.fileName,
          classification: 'GENERAL',
          // P-3: Magic-Bytes statt Client-Header — siehe M-2.
          mimeType: committed.detectedMime ?? parsed.data.mimeType,
          // Mandant-originierter Formular-Upload: wie beim allgemeinen
          // Portal-Upload automatisch für denselben Mandanten freigeben,
          // damit der unmittelbar gerenderte Download-Link nicht 404 liefert.
          // sharedByStaff bleibt bewusst null.
          sharedWithClientAt: new Date(),
          formSubmissionId: currentSub.id,
          formFieldKey: currentField.key,
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageBucket: committed.targetBucket,
          storageKey: committed.targetKey,
          storageVersionId: committed.storageVersionId,
          sha256: prismaBytes(committed.sha256),
          sizeBytes: committed.sizeBytes,
          immutable: committed.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: contactId,
        },
      });
      // Die Referenz gehört bereits mit dem erfolgreichen Upload zum Draft.
      // Ohne dieses atomare Mitspeichern wäre die Datei nach einem Reload zwar
      // als Document vorhanden, im Formular aber nicht mehr sichtbar und damit
      // für den Mandanten auch nicht mehr verwerfbar.
      const currentAnswers = answerRecord(currentSub.answers);
      const attached = await tx.formSubmission.updateMany({
        where: {
          id: currentSub.id,
          clientId,
          status: { in: ['PENDING', 'DRAFT'] },
        },
        data: {
          status: 'DRAFT',
          answers: {
            ...currentAnswers,
            [currentField.key]: { documentId: doc.id, fileName: parsed.data.fileName },
          } as Prisma.InputJsonValue,
        },
      });
      if (attached.count !== 1) throw new ActionError('Formular wurde bereits übermittelt.');
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'form.submission.upload',
        resourceType: 'document',
        resourceId: doc.id,
        after: {
          submissionId: parsed.data.submissionId,
          fieldKey: parsed.data.fieldKey,
          fileName: parsed.data.fileName,
        },
      });
      return doc.id;
    });
  } catch (e) {
    if (stored) {
      await compensateStorageCommit({
        tenantId,
        source: 'portal.form.file',
        commit: stored,
        cause: e,
      });
    }
    return toActionError(e);
  }

  return { ok: true, documentId };
}

// ----------------------------------------------------------------------------
// FILE-Feld-Upload verwerfen (nur solange die Submission offen ist)
// ----------------------------------------------------------------------------

const DiscardUploadSchema = z.object({
  submissionId: z.string().uuid(),
  fieldKey: z.string().min(1).max(60),
  documentId: z.string().uuid(),
});

interface DiscardableStorageObject {
  bucket: string;
  key: string;
  versionId: string | null;
}

interface DiscardUploadResult {
  outcome: 'DISCARDED' | 'ALREADY_DISCARDED';
  storage: DiscardableStorageObject | null;
}

function answerRecord(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

async function discardOpenFormUploadTx(
  tx: TxClient,
  input: {
    tenantId: string;
    contactId: string;
    clientId: string;
    submissionId: string;
    fieldKey: string;
    documentId: string;
  },
): Promise<DiscardUploadResult> {
  const sub = await loadSubmissionAndCheckTx(tx, input.submissionId, input.clientId);
  const field = sub.template.fields.find((candidate) => candidate.key === input.fieldKey);
  if (field?.type !== 'FILE') throw new ActionError('Feld erwartet keinen Datei-Upload.');

  const document = await tx.document.findFirst({
    where: {
      id: input.documentId,
      tenantId: input.tenantId,
      clientId: input.clientId,
      formSubmissionId: sub.id,
      formFieldKey: field.key,
      classification: 'GENERAL',
      deletedAt: null,
    },
    include: { versions: { orderBy: { versionNo: 'asc' } } },
  });
  // Idempotent und ohne Existenz-Leak: Ein bereits vollständig verworfener
  // oder fremder Beleg wird nicht unterschieden und keinesfalls angefasst.
  if (!document) return { outcome: 'ALREADY_DISCARDED', storage: null };
  if (document.versions.length !== 1) {
    throw new ActionError('Datei besitzt keinen eindeutig löschbaren Speicherstand.');
  }
  const version = document.versions[0]!;
  if (version.immutable || version.scanStatus !== 'CLEAN') {
    throw new ActionError('Datei ist nicht als verwerfbarer Formular-Upload gespeichert.');
  }

  const currentAnswers = answerRecord(sub.answers);
  const currentFieldAnswer = currentAnswers[input.fieldKey];
  if (
    currentFieldAnswer &&
    typeof currentFieldAnswer === 'object' &&
    !Array.isArray(currentFieldAnswer) &&
    currentFieldAnswer['documentId'] === input.documentId
  ) {
    const detached = await tx.formSubmission.updateMany({
      where: { id: sub.id, clientId: input.clientId, status: { in: ['PENDING', 'DRAFT'] } },
      data: {
        answers: { ...currentAnswers, [input.fieldKey]: null } as Prisma.InputJsonValue,
      },
    });
    if (detached.count !== 1) throw new ActionError('Formular wurde bereits übermittelt.');
  }

  await evidenceService.record(tx, {
    tenantId: input.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: input.contactId,
    action: 'form.submission.upload.discard',
    resourceType: 'document',
    resourceId: document.id,
    before: {
      submissionId: sub.id,
      fieldKey: field.key,
      fileName: document.title,
    },
    after: { discarded: true, storageCleanup: 'JOURNALED' },
  });

  // DB-Zustand und Cleanup-Absicht werden atomar festgeschrieben, BEVOR der
  // externe Object-Delete startet. Stirbt der Prozess danach, sieht der
  // Mandant bereits den konsistent gelöschten Draft und der vorhandene
  // Storage-Orphan-Worker entfernt die nun unreferenzierten Bytes verzögert.
  // Damit gibt es weder ein sichtbares Dokument ohne Objekt noch ein nur bei
  // manuellem Nutzer-Retry heilbares Crash-Fenster.
  // storage_orphan ist fuer CLIENT_CONTACT absichtlich per RLS gesperrt. Die
  // eng begrenzte DB-Funktion liest alle Storage-Metadaten aus genau diesem
  // autorisierten Dokument und journalisiert sie unter SECURITY DEFINER; frei
  // uebermittelte Bucket-/Key-/Hash-Werte gibt es in diesem Pfad nicht.
  const journaled = await tx.$queryRaw<Array<{ orphanId: string }>>`
    SELECT app.journal_open_form_upload_discard(
      ${sub.id}::uuid,
      ${field.key}::text,
      ${document.id}::uuid
    ) AS "orphanId"
  `;
  if (journaled.length !== 1 || !journaled[0]?.orphanId) {
    throw new ActionError('Storage-Bereinigung konnte nicht vorgemerkt werden.');
  }
  const removed = await tx.document.deleteMany({
    where: {
      id: document.id,
      tenantId: input.tenantId,
      clientId: input.clientId,
      formSubmissionId: sub.id,
      formFieldKey: field.key,
      classification: 'GENERAL',
      deletedAt: null,
    },
  });
  if (removed.count !== 1) throw new ActionError('Datei konnte nicht verworfen werden.');
  return {
    outcome: 'DISCARDED',
    storage: {
      bucket: version.storageBucket,
      key: version.storageKey,
      versionId: version.storageVersionId,
    },
  };
}

export async function discardFormFileAction(input: {
  submissionId: string;
  fieldKey: string;
  documentId: string;
}): Promise<ActionResult> {
  const g = await portalActionGuard({ module: 'forms' });
  if (!g.ok) return g;
  const { tenantId, contactId, clientId, ctx } = g;
  const parsed = DiscardUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const rl = await checkPortalWriteLimit(contactId);
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Aktionen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }

  const discard = () =>
    withTenantContext(ctx, (tx) =>
      discardOpenFormUploadTx(tx, {
        tenantId,
        contactId,
        clientId,
        ...parsed.data,
      }),
    );

  let discarded: DiscardUploadResult;
  try {
    discarded = await discard();
  } catch (error) {
    // Ein verlorenes COMMIT-ACK ist mehrdeutig. Der idempotente zweite Lauf
    // erkennt entweder den bereits committeden Delete oder führt ihn aus;
    // Storage wurde zu diesem Zeitpunkt noch nicht angefasst.
    try {
      discarded = await discard();
    } catch (recoveryError) {
      return toActionError(recoveryError ?? error);
    }
  }

  if (discarded.storage) {
    const storageVersionId = discarded.storage.versionId?.trim() ?? '';
    try {
      if (storageVersionId) {
        await deleteObjectVersion(
          discarded.storage.bucket,
          discarded.storage.key,
          storageVersionId,
        );
      } else {
        await deleteObject(discarded.storage.bucket, discarded.storage.key);
      }
    } catch {
      // Absichtlich Erfolg: Der sichtbare/DB-seitige Delete ist committed und
      // das durable Journal lässt den Worker die Storage-Bereinigung erneut
      // versuchen. Ein technischer Fehler darf den Nutzer nicht zum Upload
      // einer bereits gelöschten Datei zurücknavigieren lassen.
    }
    // Auch bei sofort erfolgreichem Delete bleibt der Journal-Eintrag offen.
    // Der SYSTEM-Worker bestaetigt nach seiner Sicherheitsfrist den fehlenden
    // DB-Verweis und markiert den Eintrag nach einem idempotenten Delete als
    // DELETED. So wird die STAFF/SYSTEM-RLS des Journals nicht fuer das Portal
    // aufgeweicht.
  }

  revalidatePath(`/portal/forms/${parsed.data.submissionId}`);
  revalidatePath('/portal/documents');
  return { ok: true };
}
