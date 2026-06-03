'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { assertPortalFeature } from '@/server/settings/portal-features';
import { checkRateLimit } from '@/server/rate-limit';
import { withPortalContext, ActionError } from '@/server/actions/portal-action';

export interface ActionResult { ok: boolean; error?: string; id?: string; }

const SlotSchema = z.object({
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
});

const CreateSchema = z.object({
  subject: z.string().min(1).max(200),
  notes: z.string().max(2000).optional().or(z.literal('')),
  preferredStaffId: z.string().uuid().nullable().optional(),
  slots: z.array(SlotSchema).min(1).max(3),
});

export async function createAppointmentRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await portalAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  try {
    await assertPortalFeature(
      { tenantId: session.user.tenantId, actorId: session.user.contactId, actorType: 'CLIENT_CONTACT' },
      'appointmentRequests',
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // NEW4: Rate-Limit gegen Notification-Spam. resourceId pro Anfrage neu —
  // Idempotenz-Filter im Notification-Service greift nicht. Hier deshalb
  // pro contactId begrenzen (5 Anfragen/h).
  const rl = await checkRateLimit(`portal-appt:${session.user.contactId}`, {
    max: 5,
    windowSec: 60 * 60,
  });
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Termin-Anfragen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }

  // 1–3 Slot-Paare aus den nummerierten Form-Feldern einsammeln
  const slots: Array<{ startsAt: string; endsAt: string }> = [];
  for (let i = 0; i < 3; i++) {
    const s = formData.get(`slot${i}_starts`);
    const e = formData.get(`slot${i}_ends`);
    if (typeof s === 'string' && typeof e === 'string' && s && e) {
      slots.push({ startsAt: s, endsAt: e });
    }
  }

  const parsed = CreateSchema.safeParse({
    subject: formData.get('subject'),
    notes: formData.get('notes') ?? '',
    preferredStaffId: formData.get('preferredStaffId') || null,
    slots,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  for (const s of parsed.data.slots) {
    const start = new Date(s.startsAt);
    const end = new Date(s.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return { ok: false, error: 'Ungültiger Zeitstempel.' };
    }
    if (end.getTime() <= start.getTime()) {
      return { ok: false, error: 'Ende muss nach dem Start liegen.' };
    }
    if (start.getTime() < Date.now()) {
      return { ok: false, error: 'Wunschtermin muss in der Zukunft liegen.' };
    }
  }

  const { tenantId, contactId, clientId } = session.user;

  let createdId = '';
  try {
    await withTenantContext(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      async (tx) => {
        const req = await tx.appointmentRequest.create({
          data: {
            tenantId,
            clientId,
            createdByContact: contactId,
            preferredStaffId: parsed.data.preferredStaffId ?? null,
            subject: parsed.data.subject.trim(),
            notes: parsed.data.notes?.trim() || null,
            proposedSlots: parsed.data.slots as unknown as Prisma.InputJsonValue,
          },
        });
        createdId = req.id;

        await evidenceService.record(tx, {
          tenantId, actorType: 'CLIENT_CONTACT', actorId: contactId,
          action: 'appointment_request.create',
          resourceType: 'appointment_request',
          resourceId: req.id,
          after: {
            clientId,
            subject: parsed.data.subject,
            slots: parsed.data.slots.length,
            preferredStaffId: parsed.data.preferredStaffId ?? null,
          },
        });

        // Notification an präferierten Mitarbeiter — oder, wenn keiner gewählt,
        // an alle Bearbeiter mit Verantwortung für diesen Mandanten.
        if (parsed.data.preferredStaffId) {
          await notify(tx, {
            tenantId,
            staffId: parsed.data.preferredStaffId,
            kind: 'APPOINTMENT_REQUESTED',
            title: `Terminanfrage: ${parsed.data.subject}`,
            body: `${parsed.data.slots.length} Wunschtermin(e)`,
            href: '/staff/calendar',
            resourceType: 'appointment_request',
            resourceId: req.id,
          });
        } else {
          const responsibles = await tx.clientResponsibility.findMany({
            where: { clientId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
            select: { staffId: true },
          });
          const seen = new Set<string>();
          for (const r of responsibles) {
            if (seen.has(r.staffId)) continue;
            seen.add(r.staffId);
            await notify(tx, {
              tenantId,
              staffId: r.staffId,
              kind: 'APPOINTMENT_REQUESTED',
              title: `Terminanfrage: ${parsed.data.subject}`,
              body: `${parsed.data.slots.length} Wunschtermin(e)`,
              href: '/staff/calendar',
              resourceType: 'appointment_request',
              resourceId: req.id,
            });
          }
        }
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/portal/appointments');
  revalidatePath('/staff/calendar');
  return { ok: true, id: createdId };
}

export async function cancelAppointmentRequestAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withPortalContext(
    async (tx, { tenantId, contactId, clientId }) => {
      const req = await tx.appointmentRequest.findUnique({
        where: { id: parsed.data.id },
        select: { clientId: true, status: true },
      });
      if (!req) throw new ActionError('Anfrage nicht gefunden.');
      if (req.clientId !== clientId) throw new ActionError('Keine Berechtigung.');
      if (req.status !== 'PENDING') throw new ActionError('Anfrage ist nicht mehr offen.');

      await tx.appointmentRequest.update({
        where: { id: parsed.data.id },
        data: { status: 'CANCELLED', decidedAt: new Date() },
      });
      await evidenceService.record(tx, {
        tenantId, actorType: 'CLIENT_CONTACT', actorId: contactId,
        action: 'appointment_request.cancel',
        resourceType: 'appointment_request',
        resourceId: parsed.data.id,
      });
    },
    { revalidate: ['/portal/appointments', '/staff/calendar'] },
  );
}
