'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { sendTemplateMail } from '@/server/mail/dispatch';

export interface ActionResult { ok: boolean; error?: string; id?: string; }

const KindEnum = z.enum(['CLIENT_MEETING', 'INTERNAL', 'PRIVATE']);
const StatusEnum = z.enum(['PLANNED', 'CONFIRMED', 'CANCELLED', 'DONE']);

const isoLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:MM');

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  ownerStaffId: z.string().uuid(),
  clientId: z.string().uuid().nullable().optional(),
  kind: KindEnum,
  startsAt: isoLocal,
  endsAt: isoLocal,
  location: z.string().max(200).optional().or(z.literal('')),
  notes: z.string().max(4000).optional().or(z.literal('')),
});

function parseLocal(s: string): Date {
  // "YYYY-MM-DDTHH:MM" als lokale Zeit interpretieren (kein Z) — kommt aus
  // <input type="datetime-local">. Browser sendet ohne Timezone → wir
  // konvertieren explizit in den Server-Local-Time-Stempel.
  return new Date(s);
}

export async function createAppointmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = CreateSchema.safeParse({
    title: formData.get('title'),
    ownerStaffId: formData.get('ownerStaffId'),
    clientId: formData.get('clientId') || null,
    kind: formData.get('kind') ?? 'CLIENT_MEETING',
    startsAt: formData.get('startsAt'),
    endsAt: formData.get('endsAt'),
    location: formData.get('location') ?? '',
    notes: formData.get('notes') ?? '',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const startsAt = parseLocal(parsed.data.startsAt);
  const endsAt = parseLocal(parsed.data.endsAt);
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: 'Ende muss nach dem Start liegen.' };
  const { tenantId, staffId } = session.user;

  let createdId = '';
  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // P-7: Sanity-Check innerhalb des Tenants. RLS schützt cross-tenant,
        // aber FK greift nur auf Existenz im DB-Cluster — sonst kann ein
        // UI-Fehler einen ownerStaffId/clientId aus einem anderen Datenkontext
        // persistieren. Symmetrisch zu M-1.
        const owner = await tx.staffUser.findFirst({
          where: { id: parsed.data.ownerStaffId },
          select: { id: true },
        });
        if (!owner) throw new Error('STAFF_NOT_FOUND: ownerStaffId nicht in diesem Tenant.');
        if (parsed.data.clientId) {
          const cli = await tx.client.findFirst({
            where: { id: parsed.data.clientId },
            select: { id: true },
          });
          if (!cli) throw new Error('CLIENT_NOT_FOUND: clientId nicht in diesem Tenant.');
        }
        const appt = await tx.appointment.create({
          data: {
            tenantId,
            ownerStaffId: parsed.data.ownerStaffId,
            createdByStaff: staffId,
            clientId: parsed.data.clientId ?? null,
            kind: parsed.data.kind,
            title: parsed.data.title.trim(),
            location: parsed.data.location?.trim() || null,
            notes: parsed.data.notes?.trim() || null,
            startsAt,
            endsAt,
          },
        });
        createdId = appt.id;
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'appointment.create',
          resourceType: 'appointment',
          resourceId: appt.id,
          after: {
            title: parsed.data.title,
            ownerStaffId: parsed.data.ownerStaffId,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            clientId: parsed.data.clientId ?? null,
          },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/calendar');
  revalidatePath('/staff/tax-deadlines');
  return { ok: true, id: createdId };
}

const UpdateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  ownerStaffId: z.string().uuid(),
  clientId: z.string().uuid().nullable().optional(),
  kind: KindEnum,
  status: StatusEnum,
  startsAt: isoLocal,
  endsAt: isoLocal,
  location: z.string().max(200).optional().or(z.literal('')),
  notes: z.string().max(4000).optional().or(z.literal('')),
});

export async function updateAppointmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = UpdateSchema.safeParse({
    id: formData.get('id'),
    title: formData.get('title'),
    ownerStaffId: formData.get('ownerStaffId'),
    clientId: formData.get('clientId') || null,
    kind: formData.get('kind') ?? 'CLIENT_MEETING',
    status: formData.get('status') ?? 'PLANNED',
    startsAt: formData.get('startsAt'),
    endsAt: formData.get('endsAt'),
    location: formData.get('location') ?? '',
    notes: formData.get('notes') ?? '',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const startsAt = parseLocal(parsed.data.startsAt);
  const endsAt = parseLocal(parsed.data.endsAt);
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: 'Ende muss nach dem Start liegen.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const before = await tx.appointment.findUnique({
          where: { id: parsed.data.id },
          select: { title: true, startsAt: true, endsAt: true, status: true },
        });
        if (!before) throw new Error('Termin nicht gefunden.');
        await tx.appointment.update({
          where: { id: parsed.data.id },
          data: {
            title: parsed.data.title.trim(),
            ownerStaffId: parsed.data.ownerStaffId,
            clientId: parsed.data.clientId ?? null,
            kind: parsed.data.kind,
            status: parsed.data.status,
            startsAt,
            endsAt,
            location: parsed.data.location?.trim() || null,
            notes: parsed.data.notes?.trim() || null,
          },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'appointment.update',
          resourceType: 'appointment',
          resourceId: parsed.data.id,
          before,
          after: {
            title: parsed.data.title,
            status: parsed.data.status,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
          },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/calendar');
  revalidatePath('/staff/tax-deadlines');
  return { ok: true };
}

export async function deleteAppointmentAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const before = await tx.appointment.findUnique({
          where: { id: parsed.data.id },
          select: { title: true },
        });
        await tx.appointment.delete({ where: { id: parsed.data.id } });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'appointment.delete',
          resourceType: 'appointment',
          resourceId: parsed.data.id,
          before: { title: before?.title ?? null },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/calendar');
  revalidatePath('/staff/tax-deadlines');
  return { ok: true };
}

// -------------------------------------------------------------------------
// Termin-Anfragen entscheiden
// -------------------------------------------------------------------------

const AcceptSchema = z.object({
  requestId: z.string().uuid(),
  slotIndex: z.number().int().min(0).max(10),
  ownerStaffId: z.string().uuid(),
});

export async function acceptAppointmentRequestAction(input: {
  requestId: string;
  slotIndex: number;
  ownerStaffId: string;
}): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = AcceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const req = await tx.appointmentRequest.findUnique({
          where: { id: parsed.data.requestId },
          select: {
            id: true, clientId: true, subject: true, notes: true, status: true,
            proposedSlots: true, createdByContact: true,
            client: { select: { name: true } },
            createdByContactRel: { select: { fullName: true, email: true, notificationsEnabled: true, active: true } },
          },
        });
        if (!req) throw new Error('Anfrage nicht gefunden.');
        if (req.status !== 'PENDING') throw new Error('Anfrage bereits entschieden.');

        const slots = req.proposedSlots as Array<{ startsAt: string; endsAt: string }>;
        const slot = slots[parsed.data.slotIndex];
        if (!slot) throw new Error('Ungültiger Slot.');
        const startsAt = new Date(slot.startsAt);
        const endsAt = new Date(slot.endsAt);
        if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
          throw new Error('Slot-Zeitstempel kaputt.');
        }

        const appt = await tx.appointment.create({
          data: {
            tenantId,
            ownerStaffId: parsed.data.ownerStaffId,
            createdByStaff: staffId,
            clientId: req.clientId,
            kind: 'CLIENT_MEETING',
            status: 'CONFIRMED',
            title: req.subject,
            notes: req.notes,
            startsAt,
            endsAt,
            fromRequestId: req.id,
          },
        });

        await tx.appointmentRequest.update({
          where: { id: req.id },
          data: {
            status: 'ACCEPTED',
            acceptedSlot: slot as unknown as Prisma.InputJsonValue,
            acceptedAppointmentId: appt.id,
            decidedByStaff: staffId,
            decidedAt: new Date(),
          },
        });

        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'appointment_request.accept',
          resourceType: 'appointment_request',
          resourceId: req.id,
          after: { appointmentId: appt.id, slotIndex: parsed.data.slotIndex },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'appointment.create',
          resourceType: 'appointment',
          resourceId: appt.id,
          after: { fromRequest: req.id, startsAt: startsAt.toISOString() },
        });

        // Notification an Owner (sofern nicht ich selbst Owner bin)
        if (parsed.data.ownerStaffId !== staffId) {
          await notify(tx, {
            tenantId,
            staffId: parsed.data.ownerStaffId,
            kind: 'APPOINTMENT_REQUESTED',
            title: `Neuer Termin: ${req.client.name}`,
            body: `${req.subject} — ${startsAt.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}`,
            href: `/staff/calendar`,
            resourceType: 'appointment',
            resourceId: appt.id,
          });
        }

        // Bestätigungs-Mail an den Mandanten-Kontakt (außerhalb der Tx
        // wird nicht gestartet, weil wir den Empfänger nur hier sehen —
        // sendTemplateMail benutzt prismaOwner ohne Tx-Kontext, ist safe)
        const contact = req.createdByContactRel;
        if (contact && contact.active && contact.notificationsEnabled) {
          await sendTemplateMail({
            tenantId,
            slug: 'appointment-confirmed',
            to: contact.email,
            vars: {
              contact: { fullName: contact.fullName, email: contact.email },
              appointment: {
                title: req.subject,
                startsAt: startsAt.toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' }),
                location: '',
              },
            },
            n8nEvent: 'client.created',
            n8nPayload: {
              tenantId,
              kind: 'appointment-accepted',
              appointmentId: appt.id,
              requestId: req.id,
              clientId: req.clientId,
            },
            fallback: {
              subject: 'Termin-Bestätigung: {{appointment.title}}',
              bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nwir bestätigen Ihren Termin:\n\n**{{appointment.title}}**\n{{appointment.startsAt}}',
            },
          });
        }
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/calendar');
  revalidatePath('/staff/tax-deadlines');
  revalidatePath('/portal/appointments');
  return { ok: true };
}

const RejectSchema = z.object({
  requestId: z.string().uuid(),
  reason: z.string().max(500).optional().or(z.literal('')),
});

export async function rejectAppointmentRequestAction(input: {
  requestId: string;
  reason?: string;
}): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = RejectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const req = await tx.appointmentRequest.findUnique({
          where: { id: parsed.data.requestId },
          select: {
            id: true, status: true, subject: true,
            createdByContactRel: { select: { fullName: true, email: true, notificationsEnabled: true, active: true } },
          },
        });
        if (!req) throw new Error('Anfrage nicht gefunden.');
        if (req.status !== 'PENDING') throw new Error('Anfrage bereits entschieden.');

        await tx.appointmentRequest.update({
          where: { id: req.id },
          data: {
            status: 'REJECTED',
            rejectionReason: parsed.data.reason?.trim() || null,
            decidedByStaff: staffId,
            decidedAt: new Date(),
          },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'appointment_request.reject',
          resourceType: 'appointment_request',
          resourceId: req.id,
          after: { reason: parsed.data.reason ?? null },
        });

        const contact = req.createdByContactRel;
        if (contact && contact.active && contact.notificationsEnabled) {
          await sendTemplateMail({
            tenantId,
            slug: 'appointment-rejected',
            to: contact.email,
            vars: {
              contact: { fullName: contact.fullName, email: contact.email },
              request: { subject: req.subject },
              rejectionReason: parsed.data.reason?.trim() || 'Bitte schlagen Sie über das Portal alternative Zeiten vor.',
            },
            n8nEvent: 'client.created',
            n8nPayload: {
              tenantId,
              kind: 'appointment-rejected',
              requestId: req.id,
            },
            fallback: {
              subject: 'Ihre Termin-Anfrage konnten wir leider nicht annehmen',
              bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nleider können wir Ihre Termin-Anfrage „{{request.subject}}" nicht annehmen.\n\n{{rejectionReason}}',
            },
          });
        }
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/calendar');
  revalidatePath('/portal/appointments');
  return { ok: true };
}
