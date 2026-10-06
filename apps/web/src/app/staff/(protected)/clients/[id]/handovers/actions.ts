'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { enqueueDirectMailTx, kickMailOutboxDelivery } from '@/server/mail/outbox';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import {
  withStaffModule,
  staffAction,
  ActionError,
  type ActionResult,
} from '@/server/actions/staff-action';

const withHandoversStaff = withStaffModule('handovers');

const StatusEnum = z.enum(['RECEIVED', 'IN_PROGRESS', 'READY', 'PICKED_UP']);

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  label: z.string().min(1).max(200),
  contents: z.string().max(4000).optional().or(z.literal('')),
});

export async function createHandoverAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    label: formData.get('label'),
    contents: formData.get('contents') ?? '',
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  return withHandoversStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, parsed.data.clientId);
      // Q-5: clientId Tenant-Sanity
      await assertClientInTenant(tx, parsed.data.clientId);
      const h = await tx.clientHandover.create({
        data: {
          tenantId,
          clientId: parsed.data.clientId,
          label: parsed.data.label.trim(),
          contents: parsed.data.contents?.trim() || null,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client_handover.create',
        resourceType: 'client_handover',
        resourceId: h.id,
        after: { clientId: parsed.data.clientId, label: parsed.data.label },
      });
    },
    { revalidate: `/staff/clients/${parsed.data.clientId}` },
  );
}

interface HandoverReadyMail {
  clientId: string;
  label: string;
  contactEmail: string;
  contactName: string | null;
}

/**
 * Mail an Mandanten bei READY — F-08: im Status-Commit als Versandauftrag, den
 * der Worker mit Retry zustellt (n8n-Event via Dispatch-Mode BOTH wie bisher).
 */
async function enqueueHandoverReadyMailTx(
  tx: TxClient,
  input: { tenantId: string; handoverId: string; mail: HandoverReadyMail },
): Promise<void> {
  const { tenantId, handoverId, mail: p } = input;
  await enqueueDirectMailTx(
    tx,
    {
      tenantId,
      clientId: p.clientId,
      purpose: 'handover-ready',
      resource: { type: 'client_handover', id: handoverId },
      staffHref: `/staff/clients/${p.clientId}`,
    },
    {
      slug: 'handover-ready',
      to: p.contactEmail,
      vars: {
        contact: { fullName: p.contactName ?? '', email: p.contactEmail },
        label: p.label,
        handoverId,
      },
      n8nEvent: 'client.handover.ready',
      n8nPayload: {
        tenantId,
        clientId: p.clientId,
        handoverId,
        label: p.label,
        contactEmail: p.contactEmail,
        contactName: p.contactName,
      },
      fallback: {
        subject: 'Ihre Unterlagen können abgeholt werden — {{label}}',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nIhre bei uns hinterlegten Unterlagen ({{label}}) sind fertig bearbeitet und können in unseren Geschäftsräumen abgeholt werden.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
      },
    },
  );
}

export async function updateHandoverStatusAction(input: {
  id: string;
  status: 'RECEIVED' | 'IN_PROGRESS' | 'READY' | 'PICKED_UP';
}): Promise<ActionResult> {
  // staffAction (mehrphasig): die READY-Mail wird im Commit als
  // Versandauftrag abgelegt und danach angestoßen (F-08).
  return staffAction({
    guard: { module: 'handovers' },
    run: async (g) => {
      const { tenantId, ctx, session } = g;

      const parsed = z.object({ id: z.string().uuid(), status: StatusEnum }).safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

      let notifyPayload: HandoverReadyMail | null = null;
      let affectedClientId: string | null = null;

      await withTenantContext(ctx, async (tx) => {
        const before = await tx.clientHandover.findUnique({
          where: { id: parsed.data.id },
          select: {
            status: true,
            clientId: true,
            label: true,
            notifiedContactEmail: true,
            client: {
              select: {
                name: true,
                contacts: {
                  where: { active: true, notificationsEnabled: true },
                  orderBy: { createdAt: 'asc' },
                  take: 1,
                  select: { fullName: true, email: true },
                },
              },
            },
          },
        });
        if (!before) throw new ActionError('Anlieferung nicht gefunden.');
        await assertClientAccessTx(tx, session, before.clientId);
        affectedClientId = before.clientId;
        if (before.status === parsed.data.status) return;

        const now = new Date();
        const data: Prisma.ClientHandoverUpdateInput = { status: parsed.data.status };
        if (parsed.data.status === 'IN_PROGRESS') data.startedAt = now;
        if (parsed.data.status === 'READY') data.readyAt = now;
        if (parsed.data.status === 'PICKED_UP') data.pickedUpAt = now;

        // Wenn READY: ersten aktiven Kontakt als Empfänger merken
        const primary = before.client.contacts[0];
        if (parsed.data.status === 'READY' && primary && !before.notifiedContactEmail) {
          data.notifiedContactEmail = primary.email;
          notifyPayload = {
            clientId: before.clientId,
            label: before.label,
            contactEmail: primary.email,
            contactName: primary.fullName,
          };
        }

        const changed = await tx.clientHandover.updateMany({
          where: { id: parsed.data.id, status: before.status },
          data,
        });
        if (changed.count === 0) {
          throw new ActionError('Status wurde parallel geändert. Bitte Seite neu laden.');
        }

        const auditAction =
          parsed.data.status === 'IN_PROGRESS'
            ? 'client_handover.start'
            : parsed.data.status === 'READY'
              ? 'client_handover.ready'
              : parsed.data.status === 'PICKED_UP'
                ? 'client_handover.picked_up'
                : 'client_handover.status_change';

        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: g.staffId,
          action: auditAction,
          resourceType: 'client_handover',
          resourceId: parsed.data.id,
          before: { status: before.status },
          after: { status: parsed.data.status, notifiedEmail: notifyPayload?.contactEmail ?? null },
        });
        if (notifyPayload) {
          await enqueueHandoverReadyMailTx(tx, {
            tenantId,
            handoverId: parsed.data.id,
            mail: notifyPayload,
          });
        }
      });

      if (notifyPayload) kickMailOutboxDelivery();

      if (affectedClientId) revalidatePath(`/staff/clients/${affectedClientId}`);
    },
    revalidate: '/portal/handovers',
  });
}

export async function deleteHandoverAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withHandoversStaff(async (tx, { tenantId, staffId, session }) => {
    const h = await tx.clientHandover.findUnique({
      where: { id: parsed.data.id },
      select: { label: true, clientId: true },
    });
    if (!h) throw new ActionError('Anlieferung nicht gefunden.');
    await assertClientAccessTx(tx, session, h.clientId);
    await tx.clientHandover.delete({ where: { id: parsed.data.id } });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client_handover.delete',
      resourceType: 'client_handover',
      resourceId: parsed.data.id,
      before: { label: h?.label ?? null },
    });
    return { clientId: h.clientId };
  });
  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/portal/handovers');
  }
  return r;
}
