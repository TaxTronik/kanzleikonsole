'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notify } from '@/server/notifications/service';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import { assertStaffInTenant } from '@/server/db/assert-tenant';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';
import { fmtDateShort } from '@/lib/fmt';

export type ActionResult = BaseActionResult;

const CreateSchema = z.object({
  callerName: z.string().min(1).max(200),
  callerPhone: z.string().max(50).optional().or(z.literal('')),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  clientId: z.string().uuid().optional().or(z.literal('')),
  forwardToStaff: z.string().uuid().optional().or(z.literal('')),
});

export async function createPhoneNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = CreateSchema.safeParse({
    callerName: formData.get('callerName'),
    callerPhone: formData.get('callerPhone') ?? '',
    subject: formData.get('subject'),
    body: formData.get('body'),
    clientId: formData.get('clientId') ?? '',
    forwardToStaff: formData.get('forwardToStaff') ?? '',
  });
  if (!parsed.success) {
    return { ok: false, error: 'Validierungsfehler.' };
  }
  const data = parsed.data;

  let noteId: string;
  try {
    noteId = await withTenantContext(ctx, async (tx) => {
      // P-7: Sanity-Check innerhalb des Tenants. RLS schützt cross-tenant;
      // FK-Constraints prüfen nur Existenz im DB-Cluster. Innerhalb des
      // Tenants kann ein Bug/UI-Fehler sonst eine clientId/forwardToStaff
      // aus einem anderen Datenkontext persistieren. Symmetrisch zu M-1.
      if (data.clientId) {
        const c = await tx.client.findFirst({ where: { id: data.clientId }, select: { id: true } });
        if (!c) throw new Error('CLIENT_NOT_FOUND: clientId nicht in diesem Tenant.');
        // Vertraulich-/RESTRICTED-Ventil bei Mandantenbezug.
        await assertClientAccessTx(tx, g.session, data.clientId);
      }
      if (data.forwardToStaff) {
        const s = await tx.staffUser.findFirst({
          where: { id: data.forwardToStaff },
          select: { id: true },
        });
        if (!s) throw new Error('STAFF_NOT_FOUND: forwardToStaff nicht in diesem Tenant.');
      }
      const note = await tx.phoneNote.create({
        data: {
          tenantId,
          callerName: data.callerName,
          callerPhone: data.callerPhone || null,
          subject: data.subject,
          body: data.body,
          clientId: data.clientId || null,
          forwardToStaff: data.forwardToStaff || null,
          takenByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'phone_note.create',
        resourceType: 'phone_note',
        resourceId: note.id,
        after: {
          callerName: data.callerName,
          subject: data.subject,
          forwardToStaff: data.forwardToStaff || null,
          clientId: data.clientId || null,
        },
      });

      // Notification an Empfänger (außer wenn an sich selbst weitergeleitet)
      if (data.forwardToStaff && data.forwardToStaff !== staffId) {
        await notify(tx, {
          tenantId,
          staffId: data.forwardToStaff,
          kind: 'PHONE_NOTE_FORWARDED',
          title: `Telefonnotiz: ${data.subject}`,
          body: `Anrufer: ${data.callerName}${data.callerPhone ? ' · ' + data.callerPhone : ''}`,
          href: `/staff/phone-notes`,
          resourceType: 'phone_note',
          resourceId: note.id,
        });
      }

      return note.id;
    });
  } catch (e) {
    return toActionError(e);
  }

  if (data.forwardToStaff) {
    await emitN8nEvent(
      'phone_note.created',
      {
        tenantId,
        noteId,
        forwardToStaff: data.forwardToStaff,
        subject: data.subject,
      },
      { tenantId },
    );
  }

  revalidatePath('/staff/phone-notes');
  if (data.clientId) revalidatePath(`/staff/clients/${data.clientId}`);
  return { ok: true };
}

export async function markNoteReadAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return;
  // S2: UUID-Validation (symmetrisch zu markNotificationReadAction).
  const parsed = z
    .object({ noteId: z.string().uuid() })
    .safeParse({ noteId: formData.get('noteId') });
  if (!parsed.success) return;
  await markPhoneNoteRead(parsed.data.noteId, g.tenantId, g.staffId);
  revalidatePath('/staff/phone-notes');
}

export async function markPhoneNoteReadById(id: string): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'Ungültige ID.' };
  await markPhoneNoteRead(id, g.tenantId, g.staffId);
  revalidatePath('/staff/phone-notes');
  revalidatePath('/staff/dashboard');
  return { ok: true };
}

// Interner Helfer (kein UI-Action): erhält bereits autorisierten Kontext.
async function markPhoneNoteRead(id: string, tenantId: string, staffId: string): Promise<void> {
  await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    tx.phoneNote.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    }),
  );
}

// -------------------------------------------------------------------------
// Lifecycle: erledigen / zurücknehmen / weiterleiten / in Wiedervorlage
// überführen.
// -------------------------------------------------------------------------

export async function markPhoneNoteDoneAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    await tx.phoneNote.update({
      where: { id: parsed.data.id },
      data: { doneAt: new Date(), doneByStaff: staffId, readAt: new Date() },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'phone_note.done',
      resourceType: 'phone_note',
      resourceId: parsed.data.id,
    });
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePath('/staff/clients', 'layout');
    revalidatePath('/staff/dashboard');
  }
  return r;
}

export async function undoPhoneNoteDoneAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    await tx.phoneNote.update({
      where: { id: parsed.data.id },
      data: { doneAt: null, doneByStaff: null },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'phone_note.undone',
      resourceType: 'phone_note',
      resourceId: parsed.data.id,
    });
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePath('/staff/clients', 'layout');
  }
  return r;
}

export async function forwardPhoneNoteAction(input: {
  id: string;
  toStaffId: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      toStaffId: z.string().uuid(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const note = await tx.phoneNote.findUnique({
      where: { id: parsed.data.id },
      select: {
        forwardToStaff: true,
        subject: true,
        callerName: true,
        callerPhone: true,
        doneAt: true,
      },
    });
    if (!note) throw new ActionError('Telefonzettel nicht gefunden.');
    if (note.doneAt) throw new ActionError('Erledigte Zettel können nicht übertragen werden.');

    // P-7 (Befund 5): toStaffId Tenant-Sanity — Create-Pfad oben prüft
    // forwardToStaff, der Forward-Pfad fehlte.
    await assertStaffInTenant(tx, parsed.data.toStaffId);

    await tx.phoneNote.update({
      where: { id: parsed.data.id },
      data: { forwardToStaff: parsed.data.toStaffId, readAt: null },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'phone_note.forward',
      resourceType: 'phone_note',
      resourceId: parsed.data.id,
      before: { forwardToStaff: note.forwardToStaff },
      after: { forwardToStaff: parsed.data.toStaffId },
    });

    if (parsed.data.toStaffId !== staffId) {
      await notify(tx, {
        tenantId,
        staffId: parsed.data.toStaffId,
        kind: 'PHONE_NOTE_FORWARDED',
        title: `Telefonnotiz (übertragen): ${note.subject}`,
        body: `Anrufer: ${note.callerName}${note.callerPhone ? ' · ' + note.callerPhone : ''}`,
        href: `/staff/phone-notes`,
        resourceType: 'phone_note',
        resourceId: parsed.data.id,
      });
    }
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePath('/staff/clients', 'layout');
  }
  return r;
}

export async function phoneNoteToReminderAction(input: {
  id: string;
  dueDate: string;
  assigneeStaffId?: string | null;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      assigneeStaffId: z.string().uuid().nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const note = await tx.phoneNote.findUnique({
      where: { id: parsed.data.id },
      select: {
        clientId: true,
        subject: true,
        callerName: true,
        callerPhone: true,
        body: true,
        forwardToStaff: true,
        doneAt: true,
      },
    });
    if (!note) throw new ActionError('Telefonzettel nicht gefunden.');
    if (note.doneAt) throw new ActionError('Bereits erledigt.');
    if (!note.clientId)
      throw new ActionError('Telefonzettel ohne Mandantenbezug — Wiedervorlage nicht möglich.');
    await assertClientAccessTx(tx, session, note.clientId);

    // P-7 (Befund 5): vom Aufrufer übergebene assigneeStaffId Tenant-Sanity.
    // (note.forwardToStaff/staffId stammen aus dem Tenant-Kontext selbst.)
    if (parsed.data.assigneeStaffId) {
      await assertStaffInTenant(tx, parsed.data.assigneeStaffId);
    }

    const reminder = await tx.clientReminder.create({
      data: {
        tenantId,
        clientId: note.clientId,
        dueDate: new Date(parsed.data.dueDate),
        subject: `${note.callerName}: ${note.subject}`,
        notes: `Telefonnotiz vom ${fmtDateShort(new Date())}${note.callerPhone ? ' (Tel ' + note.callerPhone + ')' : ''}\n\n${note.body}`,
        createdByStaff: staffId,
        assigneeStaffId: parsed.data.assigneeStaffId ?? note.forwardToStaff ?? staffId,
      },
    });

    await tx.phoneNote.update({
      where: { id: parsed.data.id },
      data: { doneAt: new Date(), doneByStaff: staffId, readAt: new Date() },
    });

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'phone_note.to_reminder',
      resourceType: 'phone_note',
      resourceId: parsed.data.id,
      after: { reminderId: reminder.id, dueDate: parsed.data.dueDate },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client_reminder.create',
      resourceType: 'client_reminder',
      resourceId: reminder.id,
      after: {
        clientId: note.clientId,
        dueDate: parsed.data.dueDate,
        fromPhoneNote: parsed.data.id,
      },
    });
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePath('/staff/clients', 'layout');
    revalidatePath('/staff/dashboard');
  }
  return r;
}
