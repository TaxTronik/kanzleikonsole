'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { portalBaseUrl } from '@taxtronik/config';

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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };

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

  const { tenantId, staffId } = session.user;
  const data = parsed.data;

  let createdId: string;
  try {
    createdId = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
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
      },
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('GwG-Schranke')) {
      return { ok: false, error: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).' };
    }
    return { ok: false, error: msg };
  }

  const portalUrl = `${portalBaseUrl}/portal/requests/${createdId}`;
  void notifyClientContacts({
    tenantId,
    clientId: data.clientId,
    slug: 'request-opened',
    vars: {
      request: { id: createdId, title: data.title, description: data.description, priority: data.priority },
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
      bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nin Ihrem Mandantenportal liegt eine neue Anforderung für Sie bereit:\n\n**{{request.title}}**\n\n{{request.description}}\n\nBitte öffnen Sie das Portal:\n{{portalUrl}}',
    },
  });

  revalidatePath(`/staff/clients/${data.clientId}`);
  revalidatePath('/staff/requests');
  redirect(`/staff/clients/${data.clientId}`);
}

const CloseSchema = z.object({
  requestId: z.string().uuid(),
});

export async function closeRequestAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;
  const parsed = CloseSchema.safeParse({ requestId: formData.get('requestId') });
  if (!parsed.success) return;

  const { tenantId, staffId } = session.user;
  const { requestId } = parsed.data;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.request.findUnique({ where: { id: requestId } });
      if (!before) return;
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
    },
  );

  emitN8nEvent('request.closed', { tenantId, requestId });
  revalidatePath('/staff/requests');
}

const StaffResponseSchema = z.object({
  requestId: z.string().uuid(),
  message: z.string().min(1).max(5000),
});

export async function addStaffResponseAction(formData: FormData): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };

  const parsed = StaffResponseSchema.safeParse({
    requestId: formData.get('requestId'),
    message: formData.get('message'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const { requestId, message } = parsed.data;

  const ctx = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const resp = await tx.requestResponse.create({
        data: {
          requestId,
          authorType: 'STAFF',
          authorId: staffId,
          message,
        },
      });
      await tx.request.update({
        where: { id: requestId },
        data: { status: 'IN_PROGRESS' },
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
      const req = await tx.request.findUnique({
        where: { id: requestId },
        select: { clientId: true, title: true },
      });
      return req;
    },
  );

  if (ctx) {
    const portalUrl = `${portalBaseUrl}/portal/requests/${requestId}`;
    void notifyClientContacts({
      tenantId,
      clientId: ctx.clientId,
      slug: 'request-staff-replied',
      vars: {
        request: { id: requestId, title: ctx.title },
        portalUrl,
      },
      n8nEvent: 'request.responded',
      n8nPayload: { tenantId, requestId, by: 'STAFF' },
      fallback: {
        subject: 'Antwort von Ihrer Kanzlei: {{request.title}}',
        bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nIhre Kanzlei hat auf Ihre Anforderung „{{request.title}}" geantwortet.\n\nDie Antwort können Sie im Mandantenportal einsehen:\n{{portalUrl}}',
      },
    });
  }
  revalidatePath('/staff/requests');
  return { ok: true };
}
