'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { assertClientInTenant } from '@/server/db/assert-tenant';

export interface ActionResult { ok: boolean; error?: string; }

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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    label: formData.get('label'),
    contents: formData.get('contents') ?? '',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
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
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'client_handover.create',
          resourceType: 'client_handover',
          resourceId: h.id,
          after: { clientId: parsed.data.clientId, label: parsed.data.label },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/staff/clients/${parsed.data.clientId}`);
  return { ok: true };
}

export async function updateHandoverStatusAction(input: {
  id: string;
  status: 'RECEIVED' | 'IN_PROGRESS' | 'READY' | 'PICKED_UP';
}): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({
    id: z.string().uuid(),
    status: StatusEnum,
  }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  let notifyPayload: { clientId: string; label: string; contactEmail: string | null; contactName: string | null } | null = null;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const before = await tx.clientHandover.findUnique({
          where: { id: parsed.data.id },
          select: {
            status: true, clientId: true, label: true,
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
        if (!before) throw new Error('Anlieferung nicht gefunden.');
        if (before.status === parsed.data.status) return;

        const now = new Date();
        const data: Prisma.ClientHandoverUpdateInput = { status: parsed.data.status };
        if (parsed.data.status === 'IN_PROGRESS') data.startedAt = now;
        if (parsed.data.status === 'READY') data.readyAt = now;
        if (parsed.data.status === 'PICKED_UP') data.pickedUpAt = now;

        // Wenn READY: ersten aktiven Kontakt als Empfänger merken
        const primary = before.client.contacts[0];
        if (parsed.data.status === 'READY' && primary) {
          data.notifiedContactEmail = primary.email;
          notifyPayload = {
            clientId: before.clientId,
            label: before.label,
            contactEmail: primary.email,
            contactName: primary.fullName,
          };
        }

        await tx.clientHandover.update({
          where: { id: parsed.data.id },
          data,
        });

        const auditAction =
          parsed.data.status === 'IN_PROGRESS' ? 'client_handover.start' :
          parsed.data.status === 'READY' ? 'client_handover.ready' :
          parsed.data.status === 'PICKED_UP' ? 'client_handover.picked_up' :
          'client_handover.status_change';

        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: auditAction,
          resourceType: 'client_handover',
          resourceId: parsed.data.id,
          before: { status: before.status },
          after: { status: parsed.data.status, notifiedEmail: notifyPayload?.contactEmail ?? null },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Mail an Mandanten bei READY — App-Versand via Template (n8n-Event
  // automatisch via Dispatch-Mode BOTH dazugeschickt, falls aktiv).
  if (notifyPayload) {
    const p = notifyPayload as { clientId: string; label: string; contactEmail: string | null; contactName: string | null };
    if (p.contactEmail) {
      void sendTemplateMail({
        tenantId,
        slug: 'handover-ready',
        to: p.contactEmail,
        vars: {
          contact: { fullName: p.contactName ?? '', email: p.contactEmail },
          label: p.label,
          handoverId: parsed.data.id,
        },
        n8nEvent: 'client.handover.ready',
        n8nPayload: {
          tenantId,
          clientId: p.clientId,
          handoverId: parsed.data.id,
          label: p.label,
          contactEmail: p.contactEmail,
          contactName: p.contactName,
        },
        fallback: {
          subject: 'Ihre Unterlagen können abgeholt werden — {{label}}',
          bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nIhre bei uns hinterlegten Unterlagen ({{label}}) sind fertig bearbeitet und können in unseren Geschäftsräumen abgeholt werden.\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei',
        },
      }).catch(() => void 0);
    }
  }

  revalidatePath('/staff/clients', 'layout');
  revalidatePath('/portal/handovers');
  return { ok: true };
}

export async function deleteHandoverAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const h = await tx.clientHandover.findUnique({
          where: { id: parsed.data.id },
          select: { label: true },
        });
        await tx.clientHandover.delete({ where: { id: parsed.data.id } });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'client_handover.delete',
          resourceType: 'client_handover',
          resourceId: parsed.data.id,
          before: { label: h?.label ?? null },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/clients', 'layout');
  revalidatePath('/portal/handovers');
  return { ok: true };
}
