'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { portalBaseUrl } from '@taxtronik/config';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(2).max(200),
  description: z.string().min(2).max(5000),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  dueAt: z.string().datetime().optional().or(z.literal('')),
  // Optional: Anforderungs-Vorlage (rein informativ, wird im Audit gespeichert)
  templateId: z.string().uuid().optional().or(z.literal('')),
  // Optional: Formular-Template, das mit der Anforderung verschickt wird
  formTemplateId: z.string().uuid().optional().or(z.literal('')),
});

export interface ActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

export async function createRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = CreateSchema.safeParse({
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

  let createdId: string;
  try {
    createdId = await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, data.clientId);
      // Optional: Formular-Submission vorab anlegen — die Submission ist
      // im DRAFT-Status und wird mit der Request verknüpft.
      let formSubmissionId: string | null = null;
      if (data.formTemplateId) {
        const formTpl = await tx.formTemplate.findUnique({
          where: { id: data.formTemplateId },
          select: { id: true, name: true, active: true },
        });
        if (formTpl && formTpl.active) {
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
      }

      const req = await tx.request.create({
        data: {
          tenantId,
          clientId: data.clientId,
          title: data.title,
          description: data.description,
          priority: data.priority,
          dueAt: data.dueAt ? new Date(data.dueAt) : null,
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
      return req.id;
    });
  } catch (e) {
    // GwG-Schranke (DB-Trigger) → eigene, klare Meldung; sonst generisch.
    if ((e as Error).message.includes('GwG-Schranke')) {
      return { ok: false, error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).' };
    }
    return toActionError(e);
  }

  const portalUrl = `${portalBaseUrl}/portal/requests/${createdId}`;
  // Befund 3: fire-and-forget mit catch+Log statt `void` (unhandled rejection).
  fireAndForget(
    'notifyClientContacts (request-opened)',
    notifyClientContacts({
      tenantId,
      clientId: data.clientId,
      slug: 'request-opened',
      vars: {
        request: {
          id: createdId,
          title: data.title,
          description: data.description,
          priority: data.priority,
        },
        portalUrl,
      },
      n8nEvent: 'request.opened',
      n8nPayload: {
        tenantId,
        requestId: createdId,
        clientId: data.clientId,
        priority: data.priority,
        dueAt: data.dueAt ?? null,
      },
      fallback: {
        subject: 'Neue Anforderung von Ihrer Kanzlei: {{request.title}}',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nin Ihrem Mandantenportal liegt eine neue Anforderung für Sie bereit:\n\n**{{request.title}}**\n\n{{request.description}}\n\nBitte öffnen Sie das Portal:\n{{portalUrl}}',
      },
    }),
  );

  revalidatePath(`/staff/clients/${data.clientId}`);
  revalidatePath('/staff/requests');
  redirect(`/staff/clients/${data.clientId}`); // wirft (never) — NACH dem try/catch
}

const CloseSchema = z.object({
  requestId: z.string().uuid(),
});

export async function closeRequestAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return; // void-Action: still abbrechen
  const { tenantId, staffId, ctx, session } = g;

  const parsed = CloseSchema.safeParse({ requestId: formData.get('requestId') });
  if (!parsed.success) return;
  const { requestId } = parsed.data;

  await withTenantContext(ctx, async (tx) => {
    const before = await tx.request.findUnique({ where: { id: requestId } });
    if (!before) return;
    await assertClientAccessTx(tx, session, before.clientId);
    const updated = await tx.request.update({
      where: { id: requestId },
      data: { status: 'CLOSED', closedAt: new Date(), closedByStaff: staffId },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'request.close',
      resourceType: 'request',
      resourceId: requestId,
      before: { status: before.status },
      after: { status: updated.status },
    });
  });

  emitN8nEvent('request.closed', { tenantId, requestId });
  revalidatePath('/staff/requests');
}

const StaffResponseSchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().min(1).max(5000),
});

export async function addStaffResponseAction(formData: FormData): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = StaffResponseSchema.safeParse({
    requestId: formData.get('requestId'),
    message: formData.get('message'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { requestId, message } = parsed.data;

  let reqInfo: { clientId: string; title: string } | null;
  try {
    reqInfo = await withTenantContext(ctx, async (tx) => {
      const req = await tx.request.findUnique({
        where: { id: requestId },
        select: { clientId: true },
      });
      if (!req) throw new ActionError('Anforderung nicht gefunden.');
      await assertClientAccessTx(tx, session, req.clientId);
      const resp = await tx.requestResponse.create({
        data: { requestId, authorType: 'STAFF', authorId: staffId, message },
      });
      await tx.request.update({ where: { id: requestId }, data: { status: 'IN_PROGRESS' } });
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
