'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { withTenantContext } from '@taxtronik/db';
import { resolveClientContactNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { assertPortalFeature } from '@/server/settings/portal-features';
import { checkRateLimit } from '@/server/rate-limit';
import { toActionError } from '@/server/auth/rbac';
import {
  portalActionGuard,
  withPortalModule,
  ActionError,
  type ActionResult,
} from '@/server/actions/portal-action';
import { assertAppointmentStaffOptionTx } from './staff-options';

const withAppointmentsPortal = withPortalModule('appointments');
import { berlinWallClockToUtc } from '@/lib/fmt';

export type AppointmentRequestActionResult = ActionResult & {
  id?: string;
};

const SlotSchema = z.object({
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  endsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
});

const CreateSchema = z.object({
  subject: z.string().trim().min(1, 'Bitte geben Sie ein Anliegen an.').max(200),
  notes: z.string().max(2000, 'Die Notiz darf höchstens 2.000 Zeichen enthalten.').optional(),
  preferredStaffId: z.string().uuid().nullable().optional(),
  slots: z.array(SlotSchema).min(1).max(3),
});

function portalAppointmentFieldName(path: PropertyKey[]): string {
  const [root, index, slotField] = path;
  if (root !== 'slots') return typeof root === 'string' ? root : '_form';
  if (typeof index !== 'number') return 'slot0_starts';
  return slotField === 'endsAt' ? `slot${index}_ends` : `slot${index}_starts`;
}

function portalAppointmentValidationError(error: z.ZodError): AppointmentRequestActionResult {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = portalAppointmentFieldName(issue.path);
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return {
    ok: false,
    error: 'Bitte prüfen Sie die markierten Angaben.',
    errorCode: 'VALIDATION_ERROR',
    fieldErrors,
  };
}

function portalAppointmentFieldError(
  field: string,
  message: string,
): AppointmentRequestActionResult {
  return {
    ok: false,
    error: 'Bitte prüfen Sie die markierten Angaben.',
    errorCode: 'VALIDATION_ERROR',
    fieldErrors: { [field]: [message] },
  };
}

function portalAppointmentSlotError(
  slots: Array<{ startsAt: string; endsAt: string }>,
): AppointmentRequestActionResult | null {
  for (const [index, slot] of slots.entries()) {
    const start = berlinWallClockToUtc(slot.startsAt) ?? new Date(NaN);
    const end = berlinWallClockToUtc(slot.endsAt) ?? new Date(NaN);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return portalAppointmentFieldError(
        `slot${index}_starts`,
        'Bitte wählen Sie einen gültigen Zeitpunkt.',
      );
    }
    if (end.getTime() <= start.getTime()) {
      return portalAppointmentFieldError(
        `slot${index}_ends`,
        'Das Ende muss nach dem Beginn liegen.',
      );
    }
    if (start.getTime() < Date.now()) {
      return portalAppointmentFieldError(
        `slot${index}_starts`,
        'Der Wunschtermin muss in der Zukunft liegen.',
      );
    }
  }
  return null;
}

export async function createAppointmentRequestAction(
  _prev: AppointmentRequestActionResult | null,
  formData: FormData,
): Promise<AppointmentRequestActionResult> {
  const g = await portalActionGuard({ module: 'appointments' });
  if (!g.ok) return g;
  const { tenantId, contactId, clientId, ctx } = g;

  try {
    await assertPortalFeature(ctx, 'appointmentRequests');
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // NEW4: Rate-Limit gegen Notification-Spam. resourceId pro Anfrage neu —
  // Idempotenz-Filter im Notification-Service greift nicht. Hier deshalb
  // pro contactId begrenzen (5 Anfragen/h).
  const rl = await checkRateLimit(`portal-appt:${contactId}`, {
    max: 5,
    windowSec: 60 * 60,
  });
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Termin-Anfragen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
      errorCode: 'RATE_LIMITED',
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
  if (!parsed.success) return portalAppointmentValidationError(parsed.error);
  const slotError = portalAppointmentSlotError(parsed.data.slots);
  if (slotError) return slotError;

  let createdId = '';
  try {
    await withTenantContext(ctx, async (tx) => {
      // preferredStaffId ist Portal-User-kontrolliert. Der zentrale Helper
      // prüft Tenant, Aktivstatus und OPEN-/RESTRICTED-/Vertraulichkeits-Policy.
      await assertAppointmentStaffOptionTx(tx, tenantId, clientId, parsed.data.preferredStaffId);
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
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
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
    });
  } catch (e) {
    return toActionError(e);
  }
  revalidatePath('/portal/appointments');
  revalidatePath('/staff/calendar');
  return { ok: true, id: createdId };
}

export async function cancelAppointmentRequestAction(input: {
  id: string;
}): Promise<AppointmentRequestActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      error: 'Ungültige Terminanfrage.',
      errorCode: 'VALIDATION_ERROR',
    };

  return withAppointmentsPortal(
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
      await resolveClientContactNotificationsTx(tx, {
        tenantId,
        resourceType: 'appointment_request',
        resourceId: parsed.data.id,
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'appointment_request.cancel',
        resourceType: 'appointment_request',
        resourceId: parsed.data.id,
      });
    },
    { revalidate: ['/portal/appointments', '/staff/calendar'] },
  );
}
