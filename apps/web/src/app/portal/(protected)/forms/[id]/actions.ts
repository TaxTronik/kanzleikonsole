'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import type { Prisma } from '@prisma/client';
import { commitDocumentFromBytes } from '@taxtronik/storage';
import { evidenceService } from '@/server/container';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { emitN8nEvent } from '@/server/n8n/emit';
import { checkRateLimit, checkPortalWriteLimit } from '@/server/rate-limit';
import { assertPortalFeature } from '@/server/settings/portal-features';
import { toActionError } from '@/server/auth/rbac';
import { portalActionGuard, ActionError, type ActionResult } from '@/server/actions/portal-action';

const Schema = z.object({
  submissionId: z.string().uuid(),
  answers: z.record(z.string(), z.unknown()),
});

async function loadSubmissionAndCheckTx(tx: TxClient, submissionId: string, clientId: string) {
  const sub = await tx.formSubmission.findUnique({
    where: { id: submissionId },
    include: {
      template: { include: { fields: { orderBy: { position: 'asc' } } } },
    },
  });
  if (!sub) throw new ActionError('Formular nicht gefunden.');
  if (sub.clientId !== clientId) throw new ActionError('Kein Zugriff.');
  if (sub.status === 'SUBMITTED' || sub.status === 'REVIEWED') {
    throw new ActionError('Formular wurde bereits übermittelt.');
  }
  return sub;
}

export async function saveSubmissionDraftAction(
  input: z.infer<typeof Schema>,
): Promise<ActionResult> {
  const g = await portalActionGuard();
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
      await loadSubmissionAndCheckTx(tx, parsed.data.submissionId, clientId);
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
  const g = await portalActionGuard();
  if (!g.ok) return g;
  const { tenantId, contactId, clientId, ctx } = g;

  const parsed = Schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  try {
    await withTenantContext(ctx, async (tx) => {
      const sub = await loadSubmissionAndCheckTx(tx, parsed.data.submissionId, clientId);

      // Server-seitige Validierung der Pflichtfelder innerhalb derselben
      // Transaktion wie der atomare Statuswechsel. So kann weder ein paralleles
      // Autosave eine Abgabe wieder auf DRAFT setzen noch ein zweiter Submit
      // denselben fachlichen Abschluss erneut auslösen.
      for (const f of sub.template.fields) {
        if (!f.required || f.type === 'INFO_TEXT') continue;
        const v = parsed.data.answers[f.key];
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
          throw new ActionError(`Pflichtfeld nicht ausgefüllt: ${f.label}`);
        }
      }

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
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'form.submission.submit',
        resourceType: 'form_submission',
        resourceId: parsed.data.submissionId,
        after: { fieldCount: sub.template.fields.length },
      });
    });
  } catch (e) {
    return toActionError(e);
  }

  await emitN8nEvent(
    'request.responded',
    {
      tenantId,
      formSubmissionId: parsed.data.submissionId,
      clientId,
    },
    { tenantId },
  );

  revalidatePath(`/portal/forms/${parsed.data.submissionId}`);
  revalidatePath('/portal/forms');
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
  const g = await portalActionGuard();
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

    const stored = await commitDocumentFromBytes({ fileData, classification: 'GENERAL', tenantId });

    documentId = await withTenantContext(ctx, async (tx) => {
      const doc = await tx.document.create({
        data: {
          tenantId,
          clientId,
          title: parsed.data.fileName,
          classification: 'GENERAL',
          // P-3: Magic-Bytes statt Client-Header — siehe M-2.
          mimeType: stored.detectedMime ?? parsed.data.mimeType,
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: doc.id,
          versionNo: 1,
          storageBucket: stored.targetBucket,
          storageKey: stored.targetKey,
          storageVersionId: stored.storageVersionId,
          sha256: prismaBytes(stored.sha256),
          sizeBytes: stored.sizeBytes,
          immutable: stored.immutable,
          scanStatus: 'CLEAN',
          scanCompletedAt: new Date(),
          createdById: contactId,
        },
      });
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
    return toActionError(e);
  }

  return { ok: true, documentId };
}
