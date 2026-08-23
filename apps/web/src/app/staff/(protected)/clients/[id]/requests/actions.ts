'use server';

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notifyClientContacts, notifyRequestOpened } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { portalBaseUrl } from '@taxtronik/config';
import { berlinWallClockToUtc } from '@/lib/fmt';
import { toActionError, assertClientAccessTx, accessibleClientsWhereFor } from '@/server/auth/rbac';
import { staffActionGuard, ActionError, parseFormData } from '@/server/actions/staff-action';

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

const RequestClientSearchSchema = z.string().trim().max(100);
const REQUEST_CLIENT_SEARCH_LIMIT = 20;

export interface RequestClientSearchResult {
  ok: boolean;
  error?: string;
  clients?: Array<{
    id: string;
    name: string;
    datevNo: string | null;
    addisonNo: string | null;
    allowActive: boolean;
  }>;
  limited?: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  requestId?: string;
  clientId?: string;
  nextRequestId?: string;
}

const ACTIVE_GWG_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESPONDED'] as const;

function isActiveGwgRequestConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'P2002') {
    return false;
  }
  const meta = (error as { meta?: unknown }).meta;
  const detail = JSON.stringify(meta ?? '');
  return (
    detail.includes('request_gwg_id_doc_open_unique') ||
    detail.includes('linked_gwg_id_document_id') ||
    detail.includes('linkedGwgIdDocumentId')
  );
}

/**
 * Mandantensuche fuer den Quick-Dialog. Die Suche laeuft serverseitig statt
 * gegen eine beim Seitenaufruf abgeschnittene Liste. So sind auch Kanzleien
 * mit mehr als 250 Mandanten vollstaendig durchsuchbar. Noch nicht aktive
 * Mandanten werden bewusst mit Status geliefert, damit sie nicht scheinbar
 * verschwinden; die GwG-Schranke bleibt beim Erstellen unveraendert bestehen.
 */
export async function searchRequestClientsAction(
  query: string,
): Promise<RequestClientSearchResult> {
  const parsed = RequestClientSearchSchema.safeParse(query);
  if (!parsed.success) {
    return { ok: false, error: 'Der Suchbegriff ist zu lang.' };
  }

  const g = await staffActionGuard();
  if (!g.ok) return g;

  try {
    const clients = await withTenantContext(g.ctx, async (tx) => {
      const accessWhere = await accessibleClientsWhereFor(tx, g.session);
      const q = parsed.data;
      return tx.client.findMany({
        where: {
          AND: [accessWhere],
          anonymizedAt: null,
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: 'insensitive' } },
                  { datevNo: { contains: q, mode: 'insensitive' } },
                  { addisonNo: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [{ allowActive: 'desc' }, { name: 'asc' }],
        take: REQUEST_CLIENT_SEARCH_LIMIT + 1,
        select: {
          id: true,
          name: true,
          datevNo: true,
          addisonNo: true,
          allowActive: true,
        },
      });
    });

    return {
      ok: true,
      clients: clients.slice(0, REQUEST_CLIENT_SEARCH_LIMIT),
      limited: clients.length > REQUEST_CLIENT_SEARCH_LIMIT,
    };
  } catch (error) {
    return toActionError(error);
  }
}

async function createRequestCore(formData: FormData): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = CreateSchema.safeParse({
    requestId: formData.get('requestId'),
    clientId: formData.get('clientId'),
    title: formData.get('title'),
    description: formData.get('description'),
    priority: formData.get('priority') ?? 'NORMAL',
    dueAt: formData.get('dueAt') || undefined,
    templateId: formData.get('templateId') ?? '',
    formTemplateId: formData.get('formTemplateId') ?? '',
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.')] = issue.message;
    }
    return { ok: false, error: 'Validierungsfehler.', fieldErrors };
  }

  const data = parsed.data;

  // Anforderungen sind ein Kernfeature; sobald dieser Einstieg jedoch eine
  // FormSubmission erzeugt, muss zusätzlich der Formular-Schalter gelten.
  if (data.formTemplateId) {
    const formsGate = await staffActionGuard({ module: 'forms' });
    if (!formsGate.ok) return formsGate;
  }

  let createdId: string;
  let createdFresh: boolean;
  try {
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

      if (data.templateId) {
        const requestTemplate = await tx.requestTemplate.findFirst({
          where: {
            id: data.templateId,
            tenantId,
            active: true,
            OR: [{ formTemplateId: null }, { formTemplate: { active: true } }],
          },
          select: { id: true },
        });
        if (!requestTemplate) {
          throw new ActionError(
            'Die ausgewählte Anforderungsvorlage ist nicht mehr aktiv. Bitte Auswahl aktualisieren.',
          );
        }
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
      return { id: req.id, created: true };
    });
    createdId = result.id;
    createdFresh = result.created;
  } catch (e) {
    // GwG-Schranke (DB-Trigger) → eigene, klare Meldung; sonst generisch.
    if (e instanceof Error && e.message.includes('GwG-Schranke')) {
      return { ok: false, error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).' };
    }
    return toActionError(e);
  }

  if (createdFresh) {
    // Befund 3: fire-and-forget mit catch+Log statt `void` (unhandled rejection).
    // Mail/Portal-URL/n8n-Payload zentral in notifyRequestOpened — identisch
    // zum Auto-Anforderungs-Pfad des Workers (Steuertermine).
    fireAndForget(
      'notifyClientContacts (request-opened)',
      notifyRequestOpened({
        tenantId,
        clientId: data.clientId,
        requestId: createdId,
        title: data.title,
        description: data.description,
        priority: data.priority,
        dueAtIso: data.dueAt ? (berlinWallClockToUtc(data.dueAt)?.toISOString() ?? null) : null,
      }),
    );
  }

  revalidatePath(`/staff/clients/${data.clientId}`);
  revalidatePath('/staff/requests');
  return { ok: true, requestId: createdId, clientId: data.clientId };
}

/**
 * Redirectfreier Aufrufer für den Quick-Dialog. Der gesamte sichere Create-
 * Pfad (Access-/GwG-Gate, Audit, Mail und n8n) liegt in createRequestCore und
 * ist damit identisch zur vollständigen Formularseite.
 */
export async function createQuickRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const result = await createRequestCore(formData);
  return result.ok ? { ...result, nextRequestId: randomUUID() } : result;
}

/** Bestehender Vollseiten-Flow: nach erfolgreicher Erstellung zur Akte. */
export async function createRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const result = await createRequestCore(formData);
  if (!result.ok) return result;
  redirect(`/staff/clients/${result.clientId}`); // wirft (never) — NACH dem Create-Core
}

const CloseSchema = z.object({
  requestId: z.string().uuid(),
});

export async function closeRequestAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return; // void-Action: still abbrechen
  const { tenantId, staffId, ctx, session } = g;

  const parsed = parseFormData(CloseSchema, formData);
  if (!parsed.ok) return;
  const { requestId } = parsed.data;

  const closed = await withTenantContext(ctx, async (tx) => {
    const before = await tx.request.findUnique({ where: { id: requestId } });
    if (!before) return { closed: false, formSubmissionId: null as string | null };
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

  if (closed.closed) await emitN8nEvent('request.closed', { tenantId, requestId }, { tenantId });
  revalidatePath(`/staff/requests/${requestId}`);
  revalidatePath('/staff/requests');
  revalidatePath('/portal/forms');
  if (closed.formSubmissionId) revalidatePath(`/portal/forms/${closed.formSubmissionId}`);
}

/**
 * Beantwortete oder formell geschlossene Anforderungen können durch die
 * Kanzlei wieder geöffnet werden. Ein noch nicht abgesendetes verknüpftes
 * Formular wird dadurch im Portal wieder bearbeitbar; bereits
 * SUBMITTED/REVIEWED bleibt es unverändert. CANCELLED bleibt terminal.
 */
export async function reopenRequestAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = parseFormData(CloseSchema, formData);
  if (!parsed.ok) return;
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
      if (!before) return { formSubmissionId: null, conflict: false };
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
    if (isActiveGwgRequestConflict(error)) {
      redirect(`/staff/requests/${requestId}?reopenConflict=1`);
      return;
    }
    throw error;
  }

  if (result.conflict) {
    redirect(`/staff/requests/${requestId}?reopenConflict=1`);
    return;
  }

  revalidatePath(`/staff/requests/${requestId}`);
  revalidatePath('/staff/requests');
  revalidatePath('/portal/forms');
  if (result.formSubmissionId) revalidatePath(`/portal/forms/${result.formSubmissionId}`);
}

const StaffResponseSchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().min(1).max(5000),
});

export async function addStaffResponseAction(formData: FormData): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = parseFormData(StaffResponseSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Validierungsfehler.' };
  const { requestId, message } = parsed.data;

  let reqInfo: { clientId: string; title: string } | null;
  try {
    reqInfo = await withTenantContext(ctx, async (tx) => {
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
      return tx.request.findUnique({
        where: { id: requestId },
        select: { clientId: true, title: true },
      });
    });
  } catch (e) {
    return toActionError(e);
  }

  if (reqInfo) {
    const portalUrl = `${portalBaseUrl}/portal/requests/${requestId}`;
    // Befund 3: fire-and-forget mit catch+Log statt `void`.
    fireAndForget(
      'notifyClientContacts (request-staff-replied)',
      notifyClientContacts({
        tenantId,
        clientId: reqInfo.clientId,
        slug: 'request-staff-replied',
        vars: {
          request: { id: requestId, title: reqInfo.title },
          portalUrl,
        },
        n8nEvent: 'request.responded',
        n8nPayload: { tenantId, requestId, by: 'STAFF' },
        fallback: {
          subject: 'Antwort von Ihrer Kanzlei: {{request.title}}',
          bodyMd:
            'Sehr geehrte/r {{contact.fullName}},\n\nIhre Kanzlei hat auf Ihre Anforderung „{{request.title}}" geantwortet.\n\nDie Antwort können Sie im Mandantenportal einsehen:\n{{portalUrl}}',
        },
      }),
    );
  }
  revalidatePath('/staff/requests');
  return { ok: true };
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
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = parseFormData(InternalCommentSchema, formData);
  if (!parsed.ok) return { ok: false, error: 'Validierungsfehler.' };
  const { requestId, body } = parsed.data;

  try {
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
  } catch (error) {
    return toActionError(error);
  }

  revalidatePath(`/staff/requests/${requestId}`);
  return { ok: true };
}
