'use server';

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { requestOpenedMail } from '@/server/mail/dispatch';
import { enqueueClientContactsMailTx, kickMailOutboxDelivery } from '@/server/mail/outbox';
import { portalBaseUrl } from '@taxtronik/config';
import { berlinWallClockToUtc } from '@/lib/fmt';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { databaseErrorInfo } from '@/server/actions/database-error';
import {
  staffAction,
  staffActionGuard,
  ActionError,
  parseFormData,
  type ActionResult,
} from '@/server/actions/staff-action';

const CreateSchema = z.object({
  requestId: z.string().uuid(),
  clientId: z.string().uuid(),
  title: z.string().min(2).max(200),
  description: z.string().min(2).max(5000),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  // Zeitzonenloser Stempel aus <input type="datetime-local"> (Berlin-Wanduhr),
  // Konvertierung nach UTC via berlinWallClockToUtc — wie im Terminkalender.
  dueAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:MM')
    .optional()
    .or(z.literal('')),
  // Optional: Anforderungs-Vorlage (rein informativ, wird im Audit gespeichert)
  templateId: z.string().uuid().optional().or(z.literal('')),
  // Optional: Formular-Template, das mit der Anforderung verschickt wird
  formTemplateId: z.string().uuid().optional().or(z.literal('')),
});

export type RequestActionResult = ActionResult & {
  requestId?: string;
  clientId?: string;
  nextRequestId?: string;
};

const ACTIVE_GWG_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESPONDED'] as const;

const ACTIVE_GWG_REQUEST_CONSTRAINT = new Set([
  'request_gwg_id_doc_open_unique',
  'linked_gwg_id_document_id',
  'linkedGwgIdDocumentId',
]);

/** Unique-Konflikt des offenen GwG-Ausweis-Requests — über Constraint statt Meldungstext (F-03). */
function isActiveGwgRequestConflict(error: unknown): boolean {
  const info = databaseErrorInfo(error);
  if (info?.kind !== 'UNIQUE_VIOLATION') return false;
  return [info.constraint ?? []].flat().some((name) => ACTIVE_GWG_REQUEST_CONSTRAINT.has(name));
}

/**
 * F-08: Mandanten-Mail „Anforderung eröffnet" im Anlage-Commit als
 * Versandauftrag. Mail, Portal-URL und n8n-Payload zentral in requestOpenedMail
 * — identisch zum Auto-Anforderungs-Pfad des Workers (Steuertermine).
 */
async function enqueueRequestOpenedMailTx(
  tx: TxClient,
  input: { tenantId: string; requestId: string; data: z.infer<typeof CreateSchema> },
): Promise<void> {
  const { tenantId, requestId, data } = input;
  await enqueueClientContactsMailTx(
    tx,
    {
      tenantId,
      clientId: data.clientId,
      purpose: 'request-opened',
      resource: { type: 'request', id: requestId },
      staffHref: `/staff/requests/${requestId}`,
    },
    requestOpenedMail({
      tenantId,
      clientId: data.clientId,
      requestId,
      title: data.title,
      description: data.description,
      priority: data.priority,
      dueAtIso: data.dueAt ? (berlinWallClockToUtc(data.dueAt)?.toISOString() ?? null) : null,
    }),
  );
}

async function createRequestCore(formData: FormData): Promise<RequestActionResult> {
  return staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(CreateSchema, formData);
      if (!parsed.ok) return parsed;

      const data = parsed.data;

      // Anforderungen sind ein Kernfeature; sobald dieser Einstieg jedoch eine
      // FormSubmission erzeugt, muss zusätzlich der Formular-Schalter gelten.
      if (data.formTemplateId) {
        const formsGate = await staffActionGuard({ module: 'forms' });
        if (!formsGate.ok) return formsGate;
      }

      // GwG-Schranke (DB-Trigger) ordnet toActionError über SQLSTATE + Marker ein.
      const result = await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, data.clientId);

        // Eine Server-Action kann nach einem unklaren Netzwerkabbruch erneut
        // zugestellt werden. Der transaktionsweite Advisory Lock serialisiert
        // exakt dieselbe, vom Server erzeugte Request-ID; dadurch entstehen
        // weder doppelte Anforderungen noch doppelte Formulare/Audit-Eintraege.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${data.requestId}::text, 0))`;
        const replay = await tx.request.findFirst({
          where: { id: data.requestId, tenantId },
          select: {
            id: true,
            tenantId: true,
            clientId: true,
            createdByStaff: true,
            title: true,
            description: true,
            priority: true,
            dueAt: true,
            formSubmission: { select: { templateId: true } },
          },
        });
        if (replay) {
          const creationAudit = await tx.auditLog.findFirst({
            where: {
              tenantId,
              action: 'request.create',
              resourceType: 'request',
              resourceId: replay.id,
            },
            orderBy: { id: 'asc' },
            select: { after: true },
          });
          const auditAfter =
            creationAudit?.after &&
            typeof creationAudit.after === 'object' &&
            !Array.isArray(creationAudit.after)
              ? (creationAudit.after as Record<string, unknown>)
              : null;
          const requestedDueAt = data.dueAt ? berlinWallClockToUtc(data.dueAt) : null;
          const replayDueAtMatches =
            replay.dueAt === null
              ? requestedDueAt === null
              : requestedDueAt !== null && replay.dueAt.getTime() === requestedDueAt.getTime();
          const replayFormTemplateId = replay.formSubmission?.templateId ?? '';
          const replayRequestTemplateId =
            typeof auditAfter?.['templateId'] === 'string' ? auditAfter['templateId'] : '';
          if (
            replay.tenantId !== tenantId ||
            replay.clientId !== data.clientId ||
            replay.createdByStaff !== staffId ||
            replay.title !== data.title ||
            replay.description !== data.description ||
            replay.priority !== data.priority ||
            !replayDueAtMatches ||
            replayFormTemplateId !== (data.formTemplateId || '') ||
            replayRequestTemplateId !== (data.templateId || '')
          ) {
            throw new ActionError(
              'Diese Erstellungs-ID wurde bereits mit anderen Angaben verwendet. Bitte Formular neu laden.',
            );
          }
          return { id: replay.id, created: false };
        }

        let wikiArticleIds: string[] = [];
        if (data.templateId) {
          const requestTemplate = await tx.requestTemplate.findFirst({
            where: {
              id: data.templateId,
              tenantId,
              active: true,
              OR: [{ formTemplateId: null }, { formTemplate: { active: true } }],
            },
            select: { id: true, wikiArticleIds: true },
          });
          if (!requestTemplate) {
            throw new ActionError(
              'Die ausgewählte Anforderungsvorlage ist nicht mehr aktiv. Bitte Auswahl aktualisieren.',
            );
          }
          wikiArticleIds = requestTemplate.wikiArticleIds;
        }

        // Optional: Formular-Submission vorab anlegen — die Submission ist
        // im DRAFT-Status und wird mit der Request verknüpft.
        let formSubmissionId: string | null = null;
        if (data.formTemplateId) {
          const formTpl = await tx.formTemplate.findFirst({
            where: { id: data.formTemplateId, tenantId },
            select: { id: true, name: true, active: true },
          });
          if (!formTpl?.active) {
            throw new ActionError(
              'Das ausgewählte Formular ist nicht mehr aktiv. Bitte Auswahl aktualisieren.',
            );
          }
          const sub = await tx.formSubmission.create({
            data: {
              tenantId,
              templateId: formTpl.id,
              clientId: data.clientId,
              name: formTpl.name,
              status: 'PENDING',
              createdByStaff: staffId,
            },
          });
          formSubmissionId = sub.id;
        }

        const req = await tx.request.create({
          data: {
            id: data.requestId,
            tenantId,
            clientId: data.clientId,
            title: data.title,
            wikiArticleIds,
            description: data.description,
            priority: data.priority,
            dueAt: data.dueAt ? berlinWallClockToUtc(data.dueAt) : null,
            formSubmissionId,
            createdByStaff: staffId,
          },
        });

        // Submission jetzt nachträglich auf den Request verlinken (für UI-Lookup)
        if (formSubmissionId) {
          await tx.formSubmission.update({
            where: { id: formSubmissionId },
            data: { requestId: req.id },
          });
        }

        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'request.create',
          resourceType: 'request',
          resourceId: req.id,
          after: {
            clientId: data.clientId,
            title: data.title,
            priority: data.priority,
            templateId: data.templateId || null,
            formSubmissionId,
          },
        });
        await enqueueRequestOpenedMailTx(tx, { tenantId, requestId: req.id, data });
        return { id: req.id, created: true };
      });

      // Die Mandanten-Mail liegt seit dem Commit als Versandauftrag vor.
      if (result.created) kickMailOutboxDelivery();

      revalidatePath(`/staff/clients/${data.clientId}`);
      revalidatePath('/staff/requests');
      return { requestId: result.id, clientId: data.clientId };
    },
  });
}

/**
 * Redirectfreier Aufrufer für den Quick-Dialog. Der gesamte sichere Create-
 * Pfad (Access-/GwG-Gate, Audit, Mail und n8n) liegt in createRequestCore und
 * ist damit identisch zur vollständigen Formularseite.
 */
export async function createQuickRequestAction(
  _prev: RequestActionResult | null,
  formData: FormData,
): Promise<RequestActionResult> {
  const result = await createRequestCore(formData);
  return result.ok ? { ...result, nextRequestId: randomUUID() } : result;
}

/** Bestehender Vollseiten-Flow: nach erfolgreicher Erstellung zur Akte. */
export async function createRequestAction(
  _prev: RequestActionResult | null,
  formData: FormData,
): Promise<RequestActionResult> {
  const result = await createRequestCore(formData);
  if (!result.ok) return result;
  redirect(`/staff/clients/${result.clientId}`); // wirft (never) — NACH dem Create-Core
}

const CloseSchema = z.object({
  requestId: z.string().uuid(),
});

export async function closeRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(CloseSchema, formData);
      if (!parsed.ok) return parsed;
      const { requestId } = parsed.data;

      const closed = await withTenantContext(ctx, async (tx) => {
        const before = await tx.request.findUnique({ where: { id: requestId } });
        if (!before) throw new ActionError('Anforderung nicht gefunden.');
        await assertClientAccessTx(tx, session, before.clientId);
        if (!['OPEN', 'IN_PROGRESS', 'RESPONDED'].includes(before.status)) {
          return { closed: false, formSubmissionId: before.formSubmissionId };
        }
        const claimed = await tx.request.updateMany({
          // Exakter Status-CAS statt nur "nicht terminal": gewinnt parallel z. B.
          // OPEN -> RESPONDED, darf dieser Aufruf weder dessen neuen Zustand mit
          // einem stale `before: OPEN` schließen noch ein falsches Audit schreiben.
          where: { id: requestId, status: before.status },
          data: { status: 'CLOSED', closedAt: new Date(), closedByStaff: staffId },
        });
        if (claimed.count !== 1) {
          return { closed: false, formSubmissionId: before.formSubmissionId };
        }
        await resolveNotificationsTx(tx, {
          tenantId,
          resources: [{ resourceType: 'request', resourceId: requestId }],
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'request.close',
          resourceType: 'request',
          resourceId: requestId,
          before: { status: before.status },
          after: { status: 'CLOSED' },
        });
        return { closed: true, formSubmissionId: before.formSubmissionId };
      });

      if (closed.closed)
        await emitN8nEvent('request.closed', { tenantId, requestId }, { tenantId });
      revalidatePath(`/staff/requests/${requestId}`);
      revalidatePath('/staff/requests');
      revalidatePath('/portal/forms');
      if (closed.formSubmissionId) revalidatePath(`/portal/forms/${closed.formSubmissionId}`);
    },
  });
}

/**
 * Beantwortete oder formell geschlossene Anforderungen können durch die
 * Kanzlei wieder geöffnet werden. Ein noch nicht abgesendetes verknüpftes
 * Formular wird dadurch im Portal wieder bearbeitbar; bereits
 * SUBMITTED/REVIEWED bleibt es unverändert. CANCELLED bleibt terminal.
 */
export async function reopenRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const outcome = await staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(CloseSchema, formData);
      if (!parsed.ok) return parsed;
      const { requestId } = parsed.data;

      let result: { formSubmissionId: string | null; conflict: boolean };
      try {
        result = await withTenantContext(ctx, async (tx) => {
          const before = await tx.request.findUnique({
            where: { id: requestId },
            select: {
              clientId: true,
              status: true,
              closedAt: true,
              formSubmissionId: true,
              linkedGwgIdDocumentId: true,
            },
          });
          if (!before) throw new ActionError('Anforderung nicht gefunden.');
          await assertClientAccessTx(tx, session, before.clientId);

          if (before.status !== 'CLOSED' && before.status !== 'RESPONDED') {
            return { formSubmissionId: before.formSubmissionId, conflict: false };
          }

          if (before.linkedGwgIdDocumentId) {
            const activeSuccessor = await tx.request.findFirst({
              where: {
                id: { not: requestId },
                linkedGwgIdDocumentId: before.linkedGwgIdDocumentId,
                status: { in: [...ACTIVE_GWG_REQUEST_STATUSES] },
              },
              select: { id: true },
            });
            if (activeSuccessor) {
              return { formSubmissionId: before.formSubmissionId, conflict: true };
            }
          }

          const reopened = await tx.request.updateMany({
            // CAS auf den eben gelesenen, fachlich erlaubten Ausgangsstatus. So
            // beschreibt das Audit auch bei parallelen Lifecycle-Aktionen exakt
            // den Status, den dieser Aufruf tatsächlich nach OPEN überführt hat.
            where: { id: requestId, status: before.status },
            data: { status: 'OPEN', closedAt: null, closedByStaff: null },
          });
          if (reopened.count !== 1) {
            return { formSubmissionId: before.formSubmissionId, conflict: false };
          }
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'request.reopen',
            resourceType: 'request',
            resourceId: requestId,
            before: { status: before.status, closedAt: before.closedAt },
            after: { status: 'OPEN', closedAt: null },
          });
          return { formSubmissionId: before.formSubmissionId, conflict: false };
        });
      } catch (error) {
        // Die partielle DB-Unique ist der Race-Backstop, falls zwischen Vorpruefung
        // und Statuswechsel parallel der Ablauf-Worker eine neue Anforderung anlegt.
        if (isActiveGwgRequestConflict(error)) return { requestId, conflict: true };
        throw error;
      }

      if (result.conflict) return { requestId, conflict: true };

      revalidatePath(`/staff/requests/${requestId}`);
      revalidatePath('/staff/requests');
      revalidatePath('/portal/forms');
      if (result.formSubmissionId) revalidatePath(`/portal/forms/${result.formSubmissionId}`);
      return { requestId, conflict: false };
    },
  });
  if (!outcome.ok) return outcome;
  // Der Konflikt bleibt beim etablierten Seitenhinweis (?reopenConflict=1).
  if (outcome.conflict) redirect(`/staff/requests/${outcome.requestId}?reopenConflict=1`);
  return { ok: true };
}

const StaffResponseSchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().min(1).max(5000),
});

/** F-08: Mail „Kanzlei hat geantwortet" im Antwort-Commit als Versandauftrag. */
async function enqueueStaffReplyMailTx(
  tx: TxClient,
  input: { tenantId: string; requestId: string; clientId: string; title: string },
): Promise<void> {
  const { tenantId, requestId } = input;
  await enqueueClientContactsMailTx(
    tx,
    {
      tenantId,
      clientId: input.clientId,
      purpose: 'request-staff-replied',
      resource: { type: 'request', id: requestId },
      staffHref: `/staff/requests/${requestId}`,
    },
    {
      slug: 'request-staff-replied',
      vars: {
        request: { id: requestId, title: input.title },
        portalUrl: `${portalBaseUrl}/portal/requests/${requestId}`,
      },
      n8nEvent: 'request.responded',
      n8nPayload: { tenantId, requestId, by: 'STAFF' },
      fallback: {
        subject: 'Antwort von Ihrer Kanzlei: {{request.title}}',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nIhre Kanzlei hat auf Ihre Anforderung „{{request.title}}" geantwortet.\n\nDie Antwort können Sie im Mandantenportal einsehen:\n{{portalUrl}}',
      },
    },
  );
}

export async function addStaffResponseAction(formData: FormData): Promise<ActionResult> {
  return staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(StaffResponseSchema, formData);
      if (!parsed.ok) return parsed;
      const { requestId, message } = parsed.data;

      const reqInfo = await withTenantContext(ctx, async (tx) => {
        const req = await tx.request.findUnique({
          where: { id: requestId },
          select: { clientId: true, status: true },
        });
        if (!req) throw new ActionError('Anforderung nicht gefunden.');
        await assertClientAccessTx(tx, session, req.clientId);
        if (req.status !== 'OPEN' && req.status !== 'IN_PROGRESS') {
          throw new ActionError(
            'Der Portal-Vorgang ist abgeschlossen. Bitte eine interne Kanzlei-Notiz verwenden.',
          );
        }
        const claimed = await tx.request.updateMany({
          where: { id: requestId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
          data: { status: 'IN_PROGRESS' },
        });
        if (claimed.count === 0) {
          throw new ActionError(
            'Der Portal-Vorgang wurde zwischenzeitlich abgeschlossen. Bitte eine interne Kanzlei-Notiz verwenden.',
          );
        }
        const resp = await tx.requestResponse.create({
          data: { requestId, authorType: 'STAFF', authorId: staffId, message },
        });
        await resolveNotificationsTx(tx, {
          tenantId,
          resources: [{ resourceType: 'request', resourceId: requestId }],
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'request.response',
          resourceType: 'request_response',
          resourceId: resp.id,
          after: { requestId, length: message.length },
        });
        const info = await tx.request.findUnique({
          where: { id: requestId },
          select: { clientId: true, title: true },
        });
        if (info) await enqueueStaffReplyMailTx(tx, { tenantId, requestId, ...info });
        return info;
      });

      if (reqInfo) kickMailOutboxDelivery();
    },
    revalidate: '/staff/requests',
  });
}

const InternalCommentSchema = z.object({
  requestId: z.string().uuid(),
  body: z.string().trim().min(1).max(5000),
});

/**
 * Reine Kanzlei-Notiz: eigener Datentyp, nicht Teil von RequestResponse und
 * damit weder im Portal sichtbar noch an notifyClientContacts gekoppelt.
 * Bewusst unabhängig vom Request-Status, damit die Nachbearbeitung nach einer
 * Formularabgabe (RESPONDED) und auch nach formellem Abschluss möglich bleibt.
 */
export async function addRequestInternalCommentAction(formData: FormData): Promise<ActionResult> {
  return staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(InternalCommentSchema, formData);
      if (!parsed.ok) return parsed;
      const { requestId, body } = parsed.data;

      await withTenantContext(ctx, async (tx) => {
        const req = await tx.request.findUnique({
          where: { id: requestId },
          select: { clientId: true },
        });
        if (!req) throw new ActionError('Anforderung nicht gefunden.');
        await assertClientAccessTx(tx, session, req.clientId);
        const author = await tx.staffUser.findFirst({
          where: { id: staffId, tenantId },
          select: { fullName: true },
        });
        if (!author) throw new ActionError('Mitarbeiter nicht gefunden.');

        const comment = await tx.requestInternalComment.create({
          data: {
            requestId,
            authorStaffId: staffId,
            authorName: author.fullName,
            body,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'request.internal_comment.create',
          resourceType: 'request_internal_comment',
          resourceId: comment.id,
          after: { requestId, length: body.length },
        });
      });

      revalidatePath(`/staff/requests/${requestId}`);
    },
  });
}
