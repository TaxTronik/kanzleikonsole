'use server';

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { sendTemplateMail, type DispatchOptions } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { assertClientInTenant, assertStaffInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import {
  withStaff,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';
import { fmtDateTimeShort, fmtDateTimeMedium, berlinWallClockToUtc } from '@/lib/fmt';

export interface ActionResult extends BaseActionResult {
  id?: string;
}

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
  // "YYYY-MM-DDTHH:MM" kommt zeitzonenlos aus <input type="datetime-local">
  // und meint Berlin-Wanduhrzeit. Als Berlin→UTC konvertieren (NICHT
  // new Date(s) = Server-Local): sonst verschiebt ein UTC-Container jeden
  // Termin um den Berlin-Offset gegenüber der fest Berlin-formatierten Anzeige.
  return berlinWallClockToUtc(s) ?? new Date(NaN);
}

export async function createAppointmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
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
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const startsAt = parseLocal(parsed.data.startsAt);
  const endsAt = parseLocal(parsed.data.endsAt);
  if (endsAt.getTime() <= startsAt.getTime())
    return { ok: false, error: 'Ende muss nach dem Start liegen.' };

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
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
        // Vertraulich-/RESTRICTED-Ventil bei Mandantenbezug.
        await assertClientAccessTx(tx, session, parsed.data.clientId);
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
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
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
      return { id: appt.id };
    },
    { revalidate: ['/staff/calendar', '/staff/tax-deadlines'] },
  );
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
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const startsAt = parseLocal(parsed.data.startsAt);
  const endsAt = parseLocal(parsed.data.endsAt);
  if (endsAt.getTime() <= startsAt.getTime())
    return { ok: false, error: 'Ende muss nach dem Start liegen.' };

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const before = await tx.appointment.findUnique({
        where: { id: parsed.data.id },
        select: { title: true, startsAt: true, endsAt: true, status: true, clientId: true },
      });
      if (!before) throw new ActionError('Termin nicht gefunden.');
      // P-7 (Befund 5): ownerStaffId/clientId Tenant-Sanity — das Create-
      // Pendant oben prüft, der Update-Pfad fehlte.
      await assertStaffInTenant(tx, parsed.data.ownerStaffId);
      if (parsed.data.clientId) await assertClientInTenant(tx, parsed.data.clientId);
      // Vertraulich-/RESTRICTED-Ventil für alten UND neuen Mandantenbezug.
      if (before.clientId) await assertClientAccessTx(tx, session, before.clientId);
      if (parsed.data.clientId) await assertClientAccessTx(tx, session, parsed.data.clientId);
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
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
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
    { revalidate: ['/staff/calendar', '/staff/tax-deadlines'] },
  );
}

export async function deleteAppointmentAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const before = await tx.appointment.findUnique({
        where: { id: parsed.data.id },
        select: { title: true, clientId: true },
      });
      if (before?.clientId) await assertClientAccessTx(tx, session, before.clientId);
      await tx.appointment.delete({ where: { id: parsed.data.id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'appointment.delete',
        resourceType: 'appointment',
        resourceId: parsed.data.id,
        before: { title: before?.title ?? null },
      });
    },
    { revalidate: ['/staff/calendar', '/staff/tax-deadlines'] },
  );
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
  const parsed = AcceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // Befund 4: SMTP-Versand nicht innerhalb der Tx (Timeout-/Doppelversand-
  // Risiko bei Rollback nach Versand). Mail-Parameter in der Tx einsammeln,
  // Versand nach dem Commit (Muster uploadExternalInvoiceAction).
  let confirmMail: DispatchOptions | null = null;

  const r = await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      // P-7 (Befund 5): ownerStaffId Tenant-Sanity — FK prüft nur Existenz.
      await assertStaffInTenant(tx, parsed.data.ownerStaffId);
      const req = await tx.appointmentRequest.findUnique({
        where: { id: parsed.data.requestId },
        select: {
          id: true,
          clientId: true,
          subject: true,
          notes: true,
          status: true,
          proposedSlots: true,
          createdByContact: true,
          client: { select: { name: true } },
          createdByContactRel: {
            select: { fullName: true, email: true, notificationsEnabled: true, active: true },
          },
        },
      });
      if (!req) throw new ActionError('Anfrage nicht gefunden.');
      if (req.status !== 'PENDING') throw new ActionError('Anfrage bereits entschieden.');
      // Vertraulich-/RESTRICTED-Ventil.
      await assertClientAccessTx(tx, session, req.clientId);

      const slots = req.proposedSlots as Array<{ startsAt: string; endsAt: string }>;
      const slot = slots[parsed.data.slotIndex];
      if (!slot) throw new ActionError('Ungültiger Slot.');
      // Slots sind zeitzonenlose Berlin-Wanduhr-Strings (Portal-Eingabe) —
      // als Berlin→UTC konvertieren, konsistent zu parseLocal.
      const startsAt = berlinWallClockToUtc(slot.startsAt) ?? new Date(NaN);
      const endsAt = berlinWallClockToUtc(slot.endsAt) ?? new Date(NaN);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        throw new ActionError('Slot-Zeitstempel kaputt.');
      }

      // TOCTOU-Schutz: Anfrage zuerst atomar claimen (PENDING → ACCEPTED),
      // BEVOR der Termin angelegt wird. Zwei parallele Accepts würden sonst
      // zwei bestätigte Termine + zwei Bestätigungs-Mails erzeugen.
      const claim = await tx.appointmentRequest.updateMany({
        where: { id: req.id, status: 'PENDING' },
        data: {
          status: 'ACCEPTED',
          acceptedSlot: slot as unknown as Prisma.InputJsonValue,
          decidedByStaff: staffId,
          decidedAt: new Date(),
        },
      });
      if (claim.count === 0) throw new ActionError('Anfrage bereits entschieden.');

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
        data: { acceptedAppointmentId: appt.id },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'appointment_request.accept',
        resourceType: 'appointment_request',
        resourceId: req.id,
        after: { appointmentId: appt.id, slotIndex: parsed.data.slotIndex },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
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
          body: `${req.subject} — ${fmtDateTimeShort(startsAt)}`,
          href: `/staff/calendar`,
          resourceType: 'appointment',
          resourceId: appt.id,
        });
      }

      // Bestätigungs-Mail an den Mandanten-Kontakt — Empfänger sehen wir nur
      // hier in der Tx, der Versand selbst passiert nach dem Commit (Befund 4).
      const contact = req.createdByContactRel;
      if (contact && contact.active && contact.notificationsEnabled) {
        confirmMail = {
          tenantId,
          clientId: req.clientId,
          slug: 'appointment-confirmed',
          to: contact.email,
          vars: {
            contact: { fullName: contact.fullName, email: contact.email },
            appointment: {
              title: req.subject,
              startsAt: fmtDateTimeMedium(startsAt),
              location: '',
            },
          },
          // Befund 7 (Bug-Klasse R-5): vorher fälschlich 'client.created'.
          n8nEvent: 'appointment.responded',
          n8nPayload: {
            tenantId,
            kind: 'appointment-accepted',
            appointmentId: appt.id,
            requestId: req.id,
            clientId: req.clientId,
          },
          fallback: {
            subject: 'Termin-Bestätigung: {{appointment.title}}',
            bodyMd:
              'Sehr geehrte/r {{contact.fullName}},\n\nwir bestätigen Ihren Termin:\n\n**{{appointment.title}}**\n{{appointment.startsAt}}',
          },
        };
      }
    },
    { revalidate: ['/staff/calendar', '/staff/tax-deadlines', '/portal/appointments'] },
  );

  if (r.ok && confirmMail) {
    // Befund 3/4: fire-and-forget mit catch+Log — Mail-Fehler kippen die
    // bereits committete Entscheidung nicht.
    fireAndForget('sendTemplateMail (appointment-confirmed)', sendTemplateMail(confirmMail));
  }
  return r;
}

const RejectSchema = z.object({
  requestId: z.string().uuid(),
  reason: z.string().max(500).optional().or(z.literal('')),
});

export async function rejectAppointmentRequestAction(input: {
  requestId: string;
  reason?: string;
}): Promise<ActionResult> {
  const parsed = RejectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // Befund 4: Mail-Parameter in der Tx einsammeln, Versand nach dem Commit.
  let rejectMail: DispatchOptions | null = null;

  const r = await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const req = await tx.appointmentRequest.findUnique({
        where: { id: parsed.data.requestId },
        select: {
          id: true,
          status: true,
          subject: true,
          clientId: true,
          createdByContactRel: {
            select: { fullName: true, email: true, notificationsEnabled: true, active: true },
          },
        },
      });
      if (!req) throw new ActionError('Anfrage nicht gefunden.');
      if (req.status !== 'PENDING') throw new ActionError('Anfrage bereits entschieden.');
      await assertClientAccessTx(tx, session, req.clientId);

      // TOCTOU-Schutz: atomarer Claim (PENDING → REJECTED).
      const claim = await tx.appointmentRequest.updateMany({
        where: { id: req.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          rejectionReason: parsed.data.reason?.trim() || null,
          decidedByStaff: staffId,
          decidedAt: new Date(),
        },
      });
      if (claim.count === 0) throw new ActionError('Anfrage bereits entschieden.');
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'appointment_request.reject',
        resourceType: 'appointment_request',
        resourceId: req.id,
        after: { reason: parsed.data.reason ?? null },
      });

      const contact = req.createdByContactRel;
      if (contact && contact.active && contact.notificationsEnabled) {
        rejectMail = {
          tenantId,
          clientId: req.clientId,
          slug: 'appointment-rejected',
          to: contact.email,
          vars: {
            contact: { fullName: contact.fullName, email: contact.email },
            request: { subject: req.subject },
            rejectionReason:
              parsed.data.reason?.trim() ||
              'Bitte schlagen Sie über das Portal alternative Zeiten vor.',
          },
          // Befund 7 (Bug-Klasse R-5): vorher fälschlich 'client.created'.
          n8nEvent: 'appointment.responded',
          n8nPayload: {
            tenantId,
            kind: 'appointment-rejected',
            requestId: req.id,
          },
          fallback: {
            subject: 'Ihre Termin-Anfrage konnten wir leider nicht annehmen',
            bodyMd:
              'Sehr geehrte/r {{contact.fullName}},\n\nleider können wir Ihre Termin-Anfrage „{{request.subject}}" nicht annehmen.\n\n{{rejectionReason}}',
          },
        };
      }
    },
    { revalidate: ['/staff/calendar', '/portal/appointments'] },
  );

  if (r.ok && rejectMail) {
    // Befund 3/4: fire-and-forget mit catch+Log — Versand nach der Tx.
    fireAndForget('sendTemplateMail (appointment-rejected)', sendTemplateMail(rejectMail));
  }
  return r;
}
