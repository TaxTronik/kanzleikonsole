'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { revokeAllSessions } from '@/server/auth/revocation';
import { anonymizeContactInTx } from '@/server/dsgvo/anonymize-contact';
import { dsgvoResponseDeadline } from '@/server/dsgvo/deadline';
import { validateDsgvoStatusEvidence } from '@/server/dsgvo/workflow';
import { DSGVO_EXPORT_STALE_ERROR, isDsgvoExportStale } from '@/server/dsgvo/export-status';
import { enqueueDsgvoExport } from '@/server/jobs/dsgvo-export-queue';
import { log } from '@/server/logger';
import { berlinTodayUtcMidnight } from '@/lib/fmt';
import {
  staffAction,
  ActionError,
  type ActionResult,
  type StaffGuardOptions,
} from '@/server/actions/staff-action';
import { formDefault, formOptional, parseFormData } from '@/server/actions/form-data';
import { audit } from '@/server/actions/audit';

// DSGVO-Anträge sind eine Compliance-Hoheit (Art. 12 ff.) — durchweg
// ADMIN/PARTNER. Eigene, präzisere Meldung als das Standard-Gate.
const DSGVO_ADMIN: StaffGuardOptions = {
  requireAdmin: true,
  deniedMessage: 'Nur ADMIN/PARTNER darf DSGVO-Anträge bearbeiten.',
};

const YmdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  });

const CreateSchema = z.object({
  type: z.enum(['ACCESS', 'RECTIFICATION', 'ERASURE', 'RESTRICTION', 'PORTABILITY', 'OBJECTION']),
  subjectType: z.enum(['CLIENT_CONTACT', 'STAFF_USER', 'CLIENT', 'EXTERNAL']),
  subjectRefId: formDefault('', z.string().uuid().optional().or(z.literal(''))),
  subjectEmail: z.string().email().max(255),
  subjectName: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  receivedAt: YmdSchema,
});

export async function createDsgvoRequestAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const result = await staffAction({
    guard: DSGVO_ADMIN,
    run: async ({ tenantId, staffId, ctx }) => {
      const parsed = parseFormData(CreateSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const data = parsed.data;
      // Frist nach Art. 12 Abs. 3 DSGVO: 1 Monat. Monatsende-sicher (§ 188 Abs. 3
      // BGB) — ein nacktes setMonth(+1) rollt z. B. den 31.01. auf den 03.03. und
      // täuscht Bearbeitungszeit vor, die nicht besteht.
      const receivedAt = new Date(`${data.receivedAt}T00:00:00.000Z`);
      if (receivedAt > berlinTodayUtcMidnight()) {
        return { ok: false, error: 'Der Eingangstag darf nicht in der Zukunft liegen.' };
      }
      const dueDate = dsgvoResponseDeadline(receivedAt);

      const id = await withTenantContext(ctx, async (tx) => {
        let subjectName = data.subjectName.trim();
        let subjectEmail = data.subjectEmail.toLowerCase();

        // Eine gesetzte Referenz muss im Tenant und zum gewählten Betroffenen-Typ
        // existieren. Bei Personen übernehmen wir die kanonischen Stammdaten,
        // damit ein Tippfehler die Auskunft nicht der falschen Person zuordnet.
        if (data.subjectRefId) {
          if (data.subjectType === 'CLIENT_CONTACT') {
            const subject = await tx.clientContact.findUnique({
              where: { id: data.subjectRefId },
              select: { fullName: true, email: true },
            });
            if (!subject) throw new ActionError('Referenzierter Mandantenkontakt nicht gefunden.');
            subjectName = subject.fullName;
            subjectEmail = subject.email.toLowerCase();
          } else if (data.subjectType === 'STAFF_USER') {
            const subject = await tx.staffUser.findUnique({
              where: { id: data.subjectRefId },
              select: { fullName: true, email: true },
            });
            if (!subject) throw new ActionError('Referenzierte Mitarbeiterperson nicht gefunden.');
            subjectName = subject.fullName;
            subjectEmail = subject.email.toLowerCase();
          } else if (data.subjectType === 'CLIENT') {
            const subject = await tx.client.findUnique({
              where: { id: data.subjectRefId },
              select: { name: true, invoiceEmail: true },
            });
            if (!subject) throw new ActionError('Referenzierter Mandant nicht gefunden.');
            subjectName = subject.name;
            subjectEmail = subject.invoiceEmail?.toLowerCase() ?? subjectEmail;
          } else {
            throw new ActionError('Externe Personen dürfen keine interne Referenz-ID tragen.');
          }
        }

        const req = await tx.dsgvoRequest.create({
          data: {
            tenantId,
            type: data.type,
            subjectType: data.subjectType,
            subjectRefId: data.subjectRefId || null,
            subjectEmail,
            subjectName,
            description: data.description,
            receivedAt,
            dueDate,
            createdByStaff: staffId,
          },
        });
        await audit(tx, ctx, {
          action: 'dsgvo.request.create',
          resourceType: 'dsgvo_request',
          resourceId: req.id,
          after: {
            type: data.type,
            subjectType: data.subjectType,
            subjectEmail,
            receivedAt: data.receivedAt,
            dueDate: dueDate.toISOString().slice(0, 10),
          },
        });
        return req.id;
      });
      return { id };
    },
    revalidate: '/staff/admin/dsgvo',
  });
  if (!result.ok) return result;
  redirect(`/staff/admin/dsgvo/${result.id}`); // wirft (never) — NACH der Tx
}

const UpdateStatusSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(['RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED']),
  notes: formDefault('', z.string().max(5000).optional().or(z.literal(''))),
  resultDocumentId: formDefault('', z.string().uuid().optional().or(z.literal(''))),
  responseSentAt: formDefault('', YmdSchema.optional().or(z.literal(''))),
  responseMethod: formDefault('', z.string().max(200).optional().or(z.literal(''))),
  rejectionReason: formDefault('', z.string().max(5000).optional().or(z.literal(''))),
  resultReviewConfirmed: formOptional(z.literal('on').optional()),
  rejectionNoticeComplete: formOptional(z.literal('on').optional()),
});

export async function updateStatusAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: DSGVO_ADMIN,
    run: async ({ tenantId, staffId, ctx }) => {
      const parsed = parseFormData(UpdateStatusSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;
      const data = parsed.data;

      // Workflow-Nachweise (validateDsgvoStatusEvidence) melden sich als
      // ActionError und erscheinen im Formular; die Eingaben bleiben stehen.
      await withTenantContext(ctx, async (tx) => {
        const before = await tx.dsgvoRequest.findUnique({ where: { id: data.requestId } });
        if (!before) throw new ActionError('DSGVO-Antrag nicht gefunden.');

        const responseSentAt = data.responseSentAt
          ? new Date(`${data.responseSentAt}T00:00:00.000Z`)
          : null;
        if (responseSentAt && responseSentAt > berlinTodayUtcMidnight()) {
          throw new ActionError('Der Antworttag darf nicht in der Zukunft liegen.');
        }
        if (responseSentAt && responseSentAt < before.receivedAt) {
          throw new ActionError('Der Antworttag darf nicht vor dem Eingangstag liegen.');
        }

        let resultDocumentId = data.resultDocumentId || before.resultDocumentId;
        if (data.resultDocumentId) {
          const document = await tx.document.findFirst({
            where: { id: data.resultDocumentId, tenantId, deletedAt: null },
            select: { id: true },
          });
          if (!document) throw new ActionError('Ergebnisdokument nicht gefunden.');
          resultDocumentId = document.id;
        }

        const notes = data.notes || before.notes || '';
        const resultChanged = Boolean(
          data.resultDocumentId && data.resultDocumentId !== before.resultDocumentId,
        );
        const previouslyReviewedCurrentResult = Boolean(before.resultReviewedAt && !resultChanged);
        const workflowError = validateDsgvoStatusEvidence({
          from: before.status,
          to: data.status,
          type: before.type,
          notes,
          responseSentAt,
          responseMethod: data.responseMethod ?? '',
          rejectionReason: data.rejectionReason ?? '',
          rejectionNoticeComplete: data.rejectionNoticeComplete === 'on',
          hasResultArtifact: Boolean(before.resultSha256 || resultDocumentId),
          // Prüfung und Versand müssen als getrennte, zeitlich belastbare Schritte
          // vorliegen. Ein ausgetauschtes Ergebnis entwertet die frühere Prüfung.
          resultReviewed: previouslyReviewedCurrentResult,
          resultReviewedOn: before.resultReviewedAt
            ? berlinTodayUtcMidnight(before.resultReviewedAt)
            : null,
        });
        if (workflowError) throw new ActionError(workflowError);

        const updated = await tx.dsgvoRequest.update({
          where: { id: data.requestId },
          data: {
            status: data.status,
            notes: notes || null,
            resultDocumentId,
            ...(resultChanged ? { resultReviewedAt: null, resultReviewedBy: null } : {}),
            ...(data.resultReviewConfirmed &&
            data.status !== 'COMPLETED' &&
            data.status !== 'REJECTED'
              ? { resultReviewedAt: new Date(), resultReviewedBy: staffId }
              : {}),
            ...(data.status === 'COMPLETED'
              ? {
                  responseSentAt,
                  responseMethod: (data.responseMethod ?? '').trim(),
                  rejectionReason: null,
                }
              : {}),
            ...(data.status === 'REJECTED'
              ? {
                  rejectionReason: (data.rejectionReason ?? '').trim(),
                  responseSentAt,
                  responseMethod: (data.responseMethod ?? '').trim(),
                }
              : {}),
            completedAt:
              data.status === 'COMPLETED' || data.status === 'REJECTED' ? new Date() : null,
            completedByStaff:
              data.status === 'COMPLETED' || data.status === 'REJECTED' ? staffId : null,
          },
        });
        await audit(tx, ctx, {
          action: `dsgvo.request.${data.status.toLowerCase()}`,
          resourceType: 'dsgvo_request',
          resourceId: updated.id,
          before: { status: before.status },
          after: {
            status: updated.status,
            responseSentAt: updated.responseSentAt?.toISOString().slice(0, 10) ?? null,
            responseMethod: updated.responseMethod,
            rejectionReason: updated.rejectionReason,
            resultDocumentId: updated.resultDocumentId,
            hasGeneratedResult: Boolean(updated.resultSha256),
            resultReviewedAt: updated.resultReviewedAt?.toISOString() ?? null,
            rejectionNoticeComplete:
              data.status === 'REJECTED' ? data.rejectionNoticeComplete === 'on' : null,
          },
        });
      });

      revalidatePath(`/staff/admin/dsgvo/${data.requestId}`);
    },
    revalidate: '/staff/admin/dsgvo',
  });
}

/**
 * Auskunfts-Export für einen Client-Contact (Art. 15/20): alle
 * personenbezogenen Daten der Person als JSON-Paket.
 *
 * Welle 15 (Folgepunkt P-11): Die Erzeugung lief hier in der 15-s-Transaktion
 * und wuchs linear mit dem Audit-Log. Die Action legt jetzt nur den Auftrag an
 * (dsgvo_export, auditiert als dsgvo.export.requested) und stößt den Worker
 * dsgvo-export an. Er baut dasselbe Paket (@taxtronik/db/dsgvo-contact-export),
 * legt es im Object Store ab, bindet den Hash wie bisher am Antrag und auditiert
 * dsgvo.export.contact. Eine synchrone Erzeugung für kleinen Bestand gibt es
 * nicht: Der bisherige Code kannte keine Größengrenze, ein Weg hält Inhalt,
 * Status und Ablage einheitlich. Je Antrag läuft höchstens ein Auftrag; ein
 * hängengebliebener (server/dsgvo/export-status.ts) wird vor dem neuen als
 * FAILED abgeschlossen.
 */
export async function requestContactExportAction(
  requestId: string,
  contactId: string,
): Promise<{
  ok: boolean;
  error?: string;
  exportId?: string;
  alreadyActive?: boolean;
}> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async ({ tenantId, staffId, ctx }) => {
      const input = z
        .object({ requestId: z.string().uuid(), contactId: z.string().uuid() })
        .safeParse({ requestId, contactId });
      if (!input.success) return { ok: false, error: 'Validierungsfehler.' };

      const queued = await withTenantContext(ctx, async (tx) => {
        const request = await tx.dsgvoRequest.findFirst({
          where: {
            id: input.data.requestId,
            tenantId,
            subjectType: 'CLIENT_CONTACT',
            subjectRefId: input.data.contactId,
            type: { in: ['ACCESS', 'PORTABILITY'] },
            status: { in: ['RECEIVED', 'IN_PROGRESS'] },
          },
          select: { id: true },
        });
        if (!request) throw new ActionError('Passender offener DSGVO-Antrag nicht gefunden.');
        const contact = await tx.clientContact.findUnique({
          where: { id: input.data.contactId },
          select: { id: true },
        });
        if (!contact) throw new ActionError('Kontakt nicht gefunden.');

        const active = await tx.dsgvoExport.findFirst({
          where: { requestId: request.id, status: { in: ['REQUESTED', 'RUNNING'] } },
          select: { id: true, status: true, requestedAt: true, startedAt: true },
        });
        const now = new Date();
        if (active && !isDsgvoExportStale(active, now)) {
          return { exportId: active.id, alreadyActive: true };
        }
        if (active) {
          await tx.dsgvoExport.updateMany({
            where: { id: active.id, status: { in: ['REQUESTED', 'RUNNING'] } },
            data: { status: 'FAILED', finishedAt: now, error: DSGVO_EXPORT_STALE_ERROR },
          });
        }

        const created = await tx.dsgvoExport.create({
          data: {
            tenantId,
            requestId: request.id,
            contactId: contact.id,
            requestedBy: staffId,
          },
          select: { id: true },
        });
        await audit(tx, ctx, {
          action: 'dsgvo.export.requested',
          resourceType: 'dsgvo_request',
          resourceId: request.id,
          after: {
            exportId: created.id,
            contactId: contact.id,
            ...(active ? { replacedStaleExportId: active.id } : {}),
          },
        });
        return { exportId: created.id, alreadyActive: false };
      });

      if (!queued.alreadyActive) {
        try {
          await enqueueDsgvoExport({ tenantId, exportId: queued.exportId });
        } catch (error) {
          log.warn(
            {
              component: 'dsgvo-export',
              exportId: queued.exportId,
              err: error instanceof Error ? error.message : String(error),
            },
            'dsgvo-export: Auftrag nicht eingereiht',
          );
          await withTenantContext(ctx, (tx) =>
            tx.dsgvoExport.updateMany({
              where: { id: queued.exportId, status: 'REQUESTED' },
              data: { status: 'FAILED', finishedAt: new Date(), error: EXPORT_QUEUE_UNAVAILABLE },
            }),
          );
          revalidatePath(`/staff/admin/dsgvo/${input.data.requestId}`);
          return { ok: false, error: EXPORT_QUEUE_UNAVAILABLE };
        }
      }
      revalidatePath(`/staff/admin/dsgvo/${input.data.requestId}`);
      return queued;
    },
    revalidate: '/staff/admin/dsgvo',
  });
}

const EXPORT_QUEUE_UNAVAILABLE =
  'Der Auftrag konnte nicht an die Hintergrundverarbeitung übergeben werden. Bitte erneut anfordern.';

/**
 * Anonymisiert einen Client-Contact (Art. 17): Email/Name werden überschrieben,
 * Account deaktiviert. Vorgänge bleiben erhalten (Audit-Pflicht), aber nicht mehr
 * personenbezogen.
 *
 * Achtung: GoBD-pflichtige Belege (Rechnungen etc.) bleiben unverändert — die
 * Lösch-Pflicht greift nur, soweit keine gesetzliche Aufbewahrungspflicht besteht.
 */
export async function anonymizeContactAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: DSGVO_ADMIN,
    run: async ({ tenantId, staffId, ctx }) => {
      // NEW5: Input via Zod statt nur typeof — Prisma akzeptiert sonst beliebige
      // Strings für UUID-Spalten und wirft erst zur Laufzeit.
      const parsed = parseFormData(z.object({ contactId: z.string().uuid() }), formData, {
        absentAsNull: true,
        errorMessage: 'Ungültige Kontakt-ID.',
      });
      if (!parsed.ok) return parsed;
      const { contactId } = parsed.data;

      // Geteilte Anonymisierungs-Logik (auch von der Mandanten-Anonymisierung in
      // admin/dsgvo-retention genutzt). Keine gelöschten Klardaten erneut in die
      // unveränderliche Audit-Chain kopieren; Antrag-ID und Kontakt-ID liefern den
      // Rechenschaftsnachweis ohne eine zweite, unbegrenzt persistente PII-Kopie.
      await withTenantContext(ctx, async (tx) => {
        const target = await tx.clientContact.findUnique({
          where: { id: contactId },
          select: { id: true },
        });
        if (!target) throw new ActionError('Ansprechpartner nicht gefunden.');
        await revokeAllSessions('portal', contactId);
        await anonymizeContactInTx(tx, {
          tenantId,
          staffId,
          contactId,
          personalDataInAudit: false,
        });
      });
    },
    revalidate: '/staff/admin/dsgvo',
  });
}
