'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { notify } from '@/server/notifications/service';
import {
  toActionError,
  assertClientAccessTx,
  canOtherStaffAccessClientTx,
} from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import { assertStaffInTenant } from '@/server/db/assert-tenant';
import {
  staffActionGuard,
  withStaffModule,
  ActionError,
  parseFormData,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';
import { fmtDateShort } from '@/lib/fmt';
import { createReminderTx } from '@/server/reminders/service';

const withPhoneNotesStaff = withStaffModule('phoneNotes');

export type ActionResult = BaseActionResult;

function revalidatePhoneNoteClient(clientId: string | null | undefined): void {
  if (clientId) revalidatePath(`/staff/clients/${clientId}`);
}

async function assertPhoneNoteRecipientAccessTx(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  clientId: string,
): Promise<void> {
  if (!(await canOtherStaffAccessClientTx(tx, tenantId, staffId, clientId))) {
    throw new ActionError(
      'Die ausgewählte Person hat nach dem Kanzlei-Zugriffsmodus keinen Zugriff auf diesen Mandanten.',
    );
  }
}

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
  const g = await staffActionGuard({ module: 'phoneNotes' });
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
        if (data.clientId) {
          await assertPhoneNoteRecipientAccessTx(tx, tenantId, data.forwardToStaff, data.clientId);
        }
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
  const g = await staffActionGuard({ module: 'phoneNotes' });
  if (!g.ok) return;
  // S2: UUID-Validation (symmetrisch zu markNotificationReadAction).
  const parsed = parseFormData(z.object({ noteId: z.string().uuid() }), formData);
  if (!parsed.ok) return;
  try {
    await markPhoneNoteRead(parsed.data.noteId, g.tenantId, g.staffId, g.session);
  } catch (error) {
    // Form-Actions ohne Rückgabekanal behandeln fremde/vertrauliche IDs wie
    // nicht vorhandene IDs. Insbesondere darf dabei keine Notification
    // aufgelöst und kein readAt gesetzt werden.
    if ((error as Error)?.name === 'ForbiddenError') return;
    throw error;
  }
  revalidatePath('/staff/phone-notes');
}

export async function markPhoneNoteReadById(id: string): Promise<ActionResult> {
  const g = await staffActionGuard({ module: 'phoneNotes' });
  if (!g.ok) return g;
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'Ungültige ID.' };
  try {
    await markPhoneNoteRead(id, g.tenantId, g.staffId, g.session);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath('/staff/phone-notes');
  revalidatePath('/staff/dashboard');
  return { ok: true };
}

// Interner Helfer (kein UI-Action): erhält bereits autorisierten Kontext.
async function markPhoneNoteRead(
  id: string,
  tenantId: string,
  staffId: string,
  session: StaffSession,
): Promise<void> {
  await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
    const note = await tx.phoneNote.findUnique({
      where: { id },
      select: { clientId: true },
    });
    if (!note) return;
    if (note.clientId) await assertClientAccessTx(tx, session, note.clientId);
    await tx.phoneNote.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    });
    await resolveNotificationsTx(tx, {
      tenantId,
      resources: [{ resourceType: 'phone_note', resourceId: id }],
      staffIds: [staffId],
    });
  });
}

// -------------------------------------------------------------------------
// Lifecycle: erledigen / zurücknehmen / weiterleiten / verknüpfte
// Wiedervorlagen anlegen.
// -------------------------------------------------------------------------

export async function markPhoneNoteDoneAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withPhoneNotesStaff(async (tx, { tenantId, staffId, session }) => {
    const note = await tx.phoneNote.findUnique({
      where: { id: parsed.data.id },
      select: { clientId: true },
    });
    if (!note) throw new ActionError('Telefonzettel nicht gefunden.');
    if (note.clientId) await assertClientAccessTx(tx, session, note.clientId);
    await tx.phoneNote.update({
      where: { id: parsed.data.id },
      data: { doneAt: new Date(), doneByStaff: staffId, readAt: new Date() },
    });
    await resolveNotificationsTx(tx, {
      tenantId,
      resources: [{ resourceType: 'phone_note', resourceId: parsed.data.id }],
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'phone_note.done',
      resourceType: 'phone_note',
      resourceId: parsed.data.id,
    });
    return { clientId: note.clientId };
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePhoneNoteClient(r.clientId);
    revalidatePath('/staff/dashboard');
  }
  return r;
}

export async function undoPhoneNoteDoneAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withPhoneNotesStaff(async (tx, { tenantId, staffId, session }) => {
    const note = await tx.phoneNote.findUnique({
      where: { id: parsed.data.id },
      select: { clientId: true },
    });
    if (!note) throw new ActionError('Telefonzettel nicht gefunden.');
    if (note.clientId) await assertClientAccessTx(tx, session, note.clientId);
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
    return { clientId: note.clientId };
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePhoneNoteClient(r.clientId);
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

  const r = await withPhoneNotesStaff(async (tx, { tenantId, staffId, session }) => {
    const note = await tx.phoneNote.findUnique({
      where: { id: parsed.data.id },
      select: {
        forwardToStaff: true,
        subject: true,
        callerName: true,
        callerPhone: true,
        doneAt: true,
        clientId: true,
      },
    });
    if (!note) throw new ActionError('Telefonzettel nicht gefunden.');
    if (note.clientId) await assertClientAccessTx(tx, session, note.clientId);
    if (note.doneAt) throw new ActionError('Erledigte Zettel können nicht übertragen werden.');
    if (note.forwardToStaff === parsed.data.toStaffId) {
      return { clientId: note.clientId };
    }

    // P-7 (Befund 5): toStaffId Tenant-Sanity — Create-Pfad oben prüft
    // forwardToStaff, der Forward-Pfad fehlte.
    await assertStaffInTenant(tx, parsed.data.toStaffId);
    if (note.clientId) {
      await assertPhoneNoteRecipientAccessTx(tx, tenantId, parsed.data.toStaffId, note.clientId);
    }

    const forwarded = await tx.phoneNote.updateMany({
      where: {
        id: parsed.data.id,
        doneAt: null,
        forwardToStaff: note.forwardToStaff,
      },
      data: { forwardToStaff: parsed.data.toStaffId, readAt: null },
    });
    if (forwarded.count === 0) {
      throw new ActionError('Telefonzettel wurde parallel geändert. Bitte Seite neu laden.');
    }

    await resolveNotificationsTx(tx, {
      tenantId,
      resources: [{ resourceType: 'phone_note', resourceId: parsed.data.id }],
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
    return { clientId: note.clientId };
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePhoneNoteClient(r.clientId);
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

  const remindersGate = await staffActionGuard({ module: 'reminders' });
  if (!remindersGate.ok) return remindersGate;

  const r = await withPhoneNotesStaff(async (tx, { tenantId, staffId, session }) => {
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
    if (parsed.data.assigneeStaffId) await assertStaffInTenant(tx, parsed.data.assigneeStaffId);
    const assigneeStaffId = parsed.data.assigneeStaffId ?? note.forwardToStaff ?? staffId;
    await assertPhoneNoteRecipientAccessTx(tx, tenantId, assigneeStaffId, note.clientId);

    const reminder = await createReminderTx(tx, {
      tenantId,
      clientId: note.clientId,
      phoneNoteId: parsed.data.id,
      dueDate: new Date(parsed.data.dueDate),
      subject: `${note.callerName}: ${note.subject}`,
      notes: `Telefonnotiz vom ${fmtDateShort(new Date())}${note.callerPhone ? ' (Tel ' + note.callerPhone + ')' : ''}\n\n${note.body}`,
      priority: 'NORMAL',
      createdByStaff: staffId,
      assigneeStaffIds: [assigneeStaffId],
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
        phoneNoteId: parsed.data.id,
      },
    });
    return { clientId: note.clientId };
  });
  if (r.ok) {
    revalidatePath('/staff/phone-notes');
    revalidatePhoneNoteClient(r.clientId);
    revalidatePath('/staff/reminders');
    revalidatePath('/staff/dashboard');
  }
  return r;
}
