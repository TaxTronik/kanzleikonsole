'use server';

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { portalBaseUrl } from '@taxtronik/config';
import { prismaOwner } from '@/server/db/prisma-owner';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { isStaffAdmin, toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  parseFormData,
} from '@/server/actions/staff-action';
import { readModules } from '@/server/settings/modules';
import type { StaffSession } from '@/server/auth/staff';
import { MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import {
  persistResumableDocumentUpload,
  ResumableDocumentUploadError,
  ResumableDocumentUploadInvariantError,
} from '@/server/documents/resumable-upload';
import { buildPoaSigningSnapshot, isPoaExpired } from '@/server/poa/signing-snapshot';
import { POA_CREATE_RETURN_CONTEXTS, poaCreateSuccessHref } from './new/return-context';

import { SIGNING_TOKEN_TTL_HOURS, hashToken } from './_signing-shared';

const CreateSchema = z
  .object({
    clientId: z.string().uuid(),
    signerContactId: z.string().uuid().optional().or(z.literal('')),
    signerEmail: z.string().email().max(255),
    signerName: z.string().min(1).max(200),
    subject: z.string().min(1).max(300),
    scope: z.string().max(20000).optional(),
    validFrom: z.string().date(),
    validUntil: z.string().date().optional().or(z.literal('')),
    pendingDocumentId: z.string().uuid().optional().or(z.literal('')),
    uploadIntentId: z.string().uuid().optional().or(z.literal('')),
    returnContext: z.enum(POA_CREATE_RETURN_CONTEXTS).optional().or(z.literal('')),
  })
  .superRefine((value, ctx) => {
    if (value.validUntil && value.validUntil < value.validFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['validUntil'],
        message: 'Das Gültig-bis-Datum darf nicht vor dem Gültig-ab-Datum liegen.',
      });
    }
  });

export interface ActionResult {
  ok: boolean;
  error?: string;
  pendingDocumentId?: string;
}

/**
 * Prueft alle mandatsbezogenen Voraussetzungen, die vor einem unveraenderbaren
 * PDF-Commit sicher feststehen muessen. Beim eigentlichen Insert wird dieselbe
 * Pruefung erneut ausgefuehrt, damit Parallel-Aenderungen nicht unbemerkt
 * zwischen Preflight und Datenbank-Transaktion durchrutschen.
 */
async function assertPoaCreateContextTx(
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

async function readPoaPdfBytes(formData: FormData): Promise<Buffer> {
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

function poaUploadErrorResult(error: unknown): ActionResult {
  if (!(error instanceof ResumableDocumentUploadError)) return toActionError(error);
  const cause = poaUploadCause(error.cause);
  switch (error.phase) {
    case 'prepare':
      if (cause instanceof ActionError) return toActionError(cause);
      return { ok: false, error: `Upload-Prüfung fehlgeschlagen: ${(cause as Error).message}` };
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

export async function createPoaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return { ok: false, error: g.error };
  const { tenantId, staffId, ctx, session } = g;

  // R-4: Vollmachtserteilung ist berufsrechtlich eine Erklärung des
  // Steuerberaters (§§ 3 ff. StBerG) — der Berufsträger trägt die Haftung.
  // Ein Sachbearbeiter ohne Bestellung darf das technisch nicht auslösen
  // können. ADMIN/PARTNER (in der Praxis: Kanzleileitung + Partner =
  // Berufsträger) als Gate. Für 4-Augen-Workflow später separater Schritt.
  if (!isStaffAdmin(session)) {
    return {
      ok: false,
      error: 'Vollmachten dürfen nur von ADMIN/PARTNER (Berufsträger) angelegt werden.',
    };
  }

  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    signerContactId: formData.get('signerContactId') ?? '',
    signerEmail: formData.get('signerEmail'),
    signerName: formData.get('signerName'),
    subject: formData.get('subject'),
    // Im Extern-Modus sendet das Form kein scope-Feld → formData.get liefert
    // null. Zod .optional() akzeptiert aber nur undefined, nicht null — daher
    // auf '' coalescen (s. #2 "expected string, received null").
    scope: formData.get('scope') ?? '',
    validFrom: formData.get('validFrom'),
    validUntil: formData.get('validUntil') ?? '',
    pendingDocumentId: formData.get('pendingDocumentId') ?? '',
    uploadIntentId: formData.get('uploadIntentId') ?? '',
    returnContext: formData.get('returnContext') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(', ') };
  }

  const data = parsed.data;

  const modules = await readModules(ctx);
  if (modules.poaMode === 'OFF') {
    return {
      ok: false,
      error: 'Das Vollmachten-Modul ist deaktiviert.',
      pendingDocumentId: data.pendingDocumentId || undefined,
    };
  }
  const externMode = modules.poaMode === 'PDF_TEMPLATE';

  // Ein bereits journalisierter PDF-Intent darf bei einem parallelen
  // Modulwechsel nicht still als neue In-App-Vollmacht weiterlaufen. Die
  // stabile ID bleibt in der URL und kann nach Reaktivierung fortgesetzt
  // werden; es entsteht kein zweites, verwaistes Dokument.
  if (!externMode && (data.pendingDocumentId || data.uploadIntentId)) {
    const intentId = data.pendingDocumentId || data.uploadIntentId;
    let trackedIntent: { id: string } | null;
    try {
      trackedIntent = await withTenantContext(ctx, (tx) =>
        tx.document.findFirst({
          where: { id: intentId, tenantId, deletedAt: null },
          select: { id: true },
        }),
      );
    } catch (e) {
      return toActionError(e);
    }
    if (trackedIntent) {
      return {
        ok: false,
        error:
          'Ein PDF-Upload für diese Vollmacht ist bereits vorgemerkt. Bitte den PDF-Modus wieder aktivieren und den Vorgang fortsetzen.',
        pendingDocumentId: trackedIntent.id,
      };
    }
  }

  // Scope: Im In-App-Modus (MARKDOWN_OTP) Pflicht (Inline-Text). Im Extern-
  // Modus wird kein Inline-Text gepflegt — das DB-Pflichtfeld bekommt einen
  // Deskriptor, der klar macht, dass die echte Vollmacht als PDF hinterlegt ist.
  const scopeRaw = (data.scope ?? '').trim();
  if (!externMode && !scopeRaw) {
    return { ok: false, error: 'Umfang (Markdown) ist im In-App-Modus Pflicht.' };
  }
  const scope = externMode ? '— Extern als PDF hinterlegt —' : scopeRaw;

  // Extern-Modus: Das PDF wird zweiphasig geschrieben. Bucket, Key und Hash
  // stehen zuerst als PENDING in der DB; dadurch kann ein COMPLIANCE-Objekt nie
  // unsichtbar werden, selbst wenn die spätere PoA-Transaktion scheitert.
  let pdfDocumentId: string | null = null;
  let pdfVersionId: string | null = null;
  if (externMode) {
    if (!data.pendingDocumentId && !data.uploadIntentId) {
      return {
        ok: false,
        error: 'Upload-Absicht fehlt. Bitte die Seite neu laden und erneut versuchen.',
      };
    }
    // Erst Zugriffs- und Lifecycle-Gates, dann der vergleichsweise teure Scan.
    try {
      await withTenantContext(ctx, (tx) =>
        assertPoaCreateContextTx(tx, session, data.clientId, data.signerContactId || undefined),
      );
    } catch (e) {
      return toActionError(e);
    }

    let existingIntentDocumentId: string | null = null;
    let existingIntentPoaId: string | null = null;
    if (!data.pendingDocumentId && data.uploadIntentId) {
      try {
        const existing = await withTenantContext(ctx, async (tx) => {
          const document = await tx.document.findFirst({
            where: { id: data.uploadIntentId, tenantId },
            select: { id: true },
          });
          if (!document) return { documentId: null, poaId: null };
          const poa = await tx.powerOfAttorney.findFirst({
            where: { tenantId, clientId: data.clientId, documentId: document.id },
            select: { id: true },
          });
          return { documentId: document.id, poaId: poa?.id ?? null };
        });
        existingIntentDocumentId = existing.documentId;
        existingIntentPoaId = existing.poaId;
      } catch (e) {
        return toActionError(e);
      }
    }
    if (existingIntentPoaId) {
      revalidatePath('/staff/poa');
      if (data.returnContext === 'onboarding') {
        revalidatePath(`/staff/clients/onboarding/${data.clientId}`);
      }
      redirect(
        poaCreateSuccessHref({
          clientId: data.clientId,
          poaId: existingIntentPoaId,
          returnContext: data.returnContext || undefined,
        }),
      );
    }

    const resumeDocumentId = data.pendingDocumentId || existingIntentDocumentId;
    try {
      const upload = await persistResumableDocumentUpload({
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
        readBytes: () => readPoaPdfBytes(formData),
        validatePrepared(prepared) {
          if (prepared.detectedMime !== 'application/pdf') {
            throw new ActionError('Der Dateiinhalt ist keine gültige PDF-Datei.');
          }
        },
        guardMutationTx: (tx) =>
          assertPoaCreateContextTx(
            tx,
            session,
            data.clientId,
            data.signerContactId || undefined,
            true,
          ),
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
      });
      pdfDocumentId = upload.documentId;
      pdfVersionId = upload.versionId;
    } catch (error) {
      return poaUploadErrorResult(error);
    }
  }

  let id: string;
  try {
    id = await withTenantContext(ctx, async (tx) => {
      await assertPoaCreateContextTx(
        tx,
        session,
        data.clientId,
        data.signerContactId || undefined,
        true,
      );
      if (pdfDocumentId && pdfVersionId) {
        await tx.$queryRaw`
          SELECT "id" FROM "document"
          WHERE "id" = ${pdfDocumentId}::uuid
            AND "tenant_id" = ${tenantId}::uuid
          FOR UPDATE
        `;
        const readyDocument = await tx.document.findFirst({
          where: {
            id: pdfDocumentId,
            tenantId,
            clientId: data.clientId,
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
          readyVersion.id !== pdfVersionId ||
          !readyVersion.immutable ||
          readyVersion.scanStatus !== 'CLEAN' ||
          !readyVersion.storageVersionId?.trim()
        ) {
          throw new ActionError('Das Vollmachts-PDF ist noch nicht vollständig gespeichert.');
        }
        const alreadyUsed = await tx.powerOfAttorney.findFirst({
          where: { tenantId, documentId: pdfDocumentId },
          select: { id: true },
        });
        if (alreadyUsed) {
          throw new ActionError('Das Vollmachts-PDF ist bereits einer Vollmacht zugeordnet.');
        }
      }
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
          documentId: pdfDocumentId,
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
          withPdf: !!pdfDocumentId,
        },
      });
      return poa.id;
    });
  } catch (e) {
    const suffix = pdfDocumentId
      ? ' Das PDF bleibt nachvollziehbar in der Mandantenakte gespeichert.'
      : '';
    if (e instanceof ActionError) {
      return {
        ok: false,
        error: `${e.message}${suffix}`,
        pendingDocumentId: pdfDocumentId ?? undefined,
      };
    }
    return {
      ok: false,
      error: `Anlegen fehlgeschlagen.${suffix}`,
      pendingDocumentId: pdfDocumentId ?? undefined,
    };
  }

  revalidatePath('/staff/poa');
  if (data.returnContext === 'onboarding') {
    revalidatePath(`/staff/clients/onboarding/${data.clientId}`);
  }
  redirect(
    poaCreateSuccessHref({
      clientId: data.clientId,
      poaId: id,
      returnContext: data.returnContext || undefined,
    }),
  );
}

const SendSchema = z.object({ poaId: z.string().uuid() });

export async function sendForSignatureAction(formData: FormData): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  if (!isStaffAdmin(g.session)) {
    return {
      ok: false,
      error: 'Vollmachten dürfen nur von ADMIN/PARTNER zur Unterschrift versendet werden.',
    };
  }

  const parsed = parseFormData(SendSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Ungültig.' };

  const { poaId } = parsed.data;

  // Token im Klartext, Hash in DB
  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SIGNING_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  let sent: {
    poa: Awaited<ReturnType<typeof prismaOwner.powerOfAttorney.update>>;
    tenantName: string;
  };
  try {
    sent = await withTenantContext(ctx, async (tx) => {
      const before = await tx.powerOfAttorney.findUnique({ where: { id: poaId } });
      if (!before) throw new ActionError('Vollmacht nicht gefunden.');
      // Vertraulich-/RESTRICTED-Ventil.
      await assertClientAccessTx(tx, g.session, before.clientId);
      if (before.status === 'SIGNED') throw new ActionError('Bereits unterschrieben.');
      if (before.status === 'REVOKED') throw new ActionError('Vollmacht ist widerrufen.');
      if (before.status === 'EXPIRED' || isPoaExpired(before.validUntil)) {
        throw new ActionError('Die Vollmacht ist abgelaufen und kann nicht mehr versendet werden.');
      }

      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) throw new ActionError('Mandant fehlt.');

      if (before.documentId) {
        // Serialisiert Versand gegen den finalen Insert einer neuen Version.
        // Gewinnt der Upload, bindet der Snapshot danach dessen neue Version;
        // gewinnt der Versand, sieht der Upload nach dem Lock den SENT-Status.
        await tx.$queryRaw`
          SELECT id FROM document
          WHERE id = ${before.documentId}::uuid
          FOR UPDATE
        `;
      }
      const documentVersion = before.documentId
        ? await tx.documentVersion.findFirst({
            where: { documentId: before.documentId },
            orderBy: { versionNo: 'desc' },
            select: { id: true, documentId: true, sha256: true },
          })
        : null;
      if (before.documentId && !documentVersion) {
        throw new ActionError('Das zu unterzeichnende Dokument hat keine gültige Version.');
      }
      const signingSnapshot = buildPoaSigningSnapshot({
        subject: before.subject,
        signerName: before.signerName,
        signerEmail: before.signerEmail,
        validFrom: before.validFrom,
        validUntil: before.validUntil,
        scope: before.scope,
        document: documentVersion
          ? {
              documentId: documentVersion.documentId,
              versionId: documentVersion.id,
              sha256: documentVersion.sha256,
            }
          : null,
      });

      // TOCTOU-Schutz: atomarer Claim. Race gegen signPoaAction — ein paralleler
      // Abschluss (→ SIGNED) darf nicht durch ein Re-Send auf SENT zurückgesetzt
      // werden (sonst frischer Signing-Token für eine bereits signierte
      // Vollmacht → Beweisspur beschädigt).
      const claim = await tx.powerOfAttorney.updateMany({
        where: { id: poaId, status: { in: ['DRAFT', 'SENT'] } },
        data: {
          status: 'SENT',
          signingTokenHash: tokenHash,
          signingTokenExpiresAt: expiresAt,
          // Etwaiges OTP zurücksetzen. Neuer Signatur-Token = neuer
          // Lebenszyklus → beide Fehlversuchszähler auf 0 (Audit 2026-06
          // Befund 2: der Total-Zähler wird NUR hier zurückgesetzt, nie
          // beim OTP-Re-Issue).
          signingOtpHash: null,
          signingOtpExpiresAt: null,
          signingOtpAttempts: 0,
          signingOtpAttemptsTotal: 0,
          signingContentSnapshot: signingSnapshot.serialized,
          signingContentSha256: prismaBytes(signingSnapshot.sha256),
          signingDocumentVersionId: documentVersion?.id ?? null,
        },
      });
      if (claim.count === 0) {
        throw new ActionError('Status wurde zwischenzeitlich geändert — bitte Seite neu laden.');
      }
      const updated = await tx.powerOfAttorney.findUniqueOrThrow({ where: { id: poaId } });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'poa.send',
        resourceType: 'power_of_attorney',
        resourceId: poaId,
        after: {
          signerEmail: before.signerEmail,
          contentSha256: signingSnapshot.sha256.toString('hex'),
          documentVersionId: documentVersion?.id ?? null,
        },
      });

      return { poa: updated, tenantName: tenant.name };
    });
  } catch (e) {
    return toActionError(e);
  }

  const link = `${portalBaseUrl}/poa/sign?token=${encodeURIComponent(rawToken)}`;
  await sendTemplateMail({
    tenantId,
    clientId: sent.poa.clientId,
    slug: 'poa-sign',
    to: sent.poa.signerEmail,
    vars: {
      contact: { fullName: sent.poa.signerName, email: sent.poa.signerEmail },
      client: { name: sent.tenantName },
      subject: sent.poa.subject,
      link,
      expiresHours: SIGNING_TOKEN_TTL_HOURS,
    },
    fallback: {
      subject: 'Bitte Vollmacht signieren — {{client.name}}',
      bodyMd:
        'Sehr geehrte/r {{contact.fullName}},\n\nbitte signieren Sie die anliegende Vollmacht über folgenden Link:\n\n{{link}}\n\nDer Link ist {{expiresHours}} Stunden gültig.',
    },
  });

  revalidatePath('/staff/poa');
  revalidatePath(`/staff/poa/${poaId}`);
  return { ok: true };
}

const RevokeSchema = z.object({
  poaId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
});

export async function revokePoaAction(formData: FormData): Promise<void> {
  const parsed = parseFormData(RevokeSchema, formData);
  if (!parsed.ok) return;

  await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      if (!isStaffAdmin(session)) {
        throw new ActionError('Vollmachten dürfen nur von ADMIN/PARTNER widerrufen werden.');
      }
      // Die Zeile wird vor Berechtigungsprüfung und Widerruf gesperrt. So
      // startet das folgende UPDATE erst nach einem eventuell konkurrierenden
      // Signatur-/Widerrufsvorgang und seine statement_timestamp()-Zeit kann
      // nicht hinter einem gerade geschriebenen signed_at liegen.
      const [before] = await tx.$queryRaw<Array<{ clientId: string; status: string }>>`
        SELECT "client_id" AS "clientId", "status"::text AS "status"
          FROM "power_of_attorney"
         WHERE "id" = ${parsed.data.poaId}::uuid
           AND "tenant_id" = ${tenantId}::uuid
         FOR UPDATE
      `;
      if (!before) throw new ActionError('Vollmacht nicht gefunden.');
      await assertClientAccessTx(tx, session, before.clientId);
      if (before.status === 'REVOKED') throw new ActionError('Bereits widerrufen.');
      // Der Trigger vergleicht revoked_at mit DB-generierten Lebenszykluszeiten.
      // Deshalb muss auch der Widerruf in genau diesem UPDATE von der DB-Uhr
      // stammen; eine JS-Date würde bei Host-/DB-Uhrabweichung sporadisch als
      // rückdatiert erscheinen. Das einzelne Statement bleibt zugleich
      // atomar mit Statuswechsel, Begründung und Token-Entwertung.
      const [updated] = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "power_of_attorney"
           SET "status" = 'REVOKED',
               "revoked_at" = statement_timestamp(),
               "revoked_reason" = ${parsed.data.reason},
               "signing_token_hash" = NULL,
               "signing_otp_hash" = NULL,
               "updated_at" = statement_timestamp()
         WHERE "id" = ${parsed.data.poaId}::uuid
           AND "tenant_id" = ${tenantId}::uuid
           AND "status" <> 'REVOKED'
         RETURNING "id"
      `;
      if (!updated) {
        throw new ActionError('Vollmacht konnte nicht widerrufen werden. Bitte laden Sie neu.');
      }
      await resolveNotificationsTx(tx, {
        tenantId,
        resources: [{ resourceType: 'power_of_attorney', resourceId: updated.id }],
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'poa.revoke',
        resourceType: 'power_of_attorney',
        resourceId: updated.id,
        after: { reason: parsed.data.reason },
      });
    },
    { revalidate: ['/staff/poa', `/staff/poa/${parsed.data.poaId}`] },
  );
}
