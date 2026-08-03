'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import {
  assertReminderAccessTx,
  darfSteuern,
  REMINDER_ACCESS_SELECT,
} from '@/server/reminders/access';
import {
  createReminderTx,
  cloneReminderTx,
  addReminderNoteTx,
  setReminderAssigneesTx,
} from '@/server/reminders/service';
import { REMINDER_PRIORITIES } from '@/lib/reminder-priority';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';
import {
  scheduleReminderDoneNotification,
  cancelReminderDoneNotification,
} from '@/server/jobs/reminder-done-queue';

const CreateSchema = z.object({
  // null/leer = interne Aufgabe ohne Mandantenbezug.
  clientId: z.string().uuid().nullable(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum YYYY-MM-DD'),
  subject: z.string().min(1).max(200),
  notes: z.string().max(2000).optional().or(z.literal('')),
  assigneeStaffIds: z.array(z.string().uuid()).max(20),
  priority: z.enum(REMINDER_PRIORITIES).default('NORMAL'),
  /** Gesetzt, wenn dies eine Nachfrage zu einer bestehenden Aufgabe ist. */
  predecessorId: z.string().uuid().nullable().optional(),
});

export async function createReminderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const rohClient = String(formData.get('clientId') ?? '').trim();
  const parsed = CreateSchema.safeParse({
    clientId: rohClient === '' || rohClient === 'intern' ? null : rohClient,
    dueDate: formData.get('dueDate'),
    subject: formData.get('subject'),
    notes: formData.get('notes') ?? '',
    // Mehrfachauswahl: getAll statt get — sonst kaeme nur die erste Person an.
    assigneeStaffIds: formData.getAll('assigneeStaffIds').map(String).filter(Boolean),
    priority: String(formData.get('priority') ?? 'NORMAL'),
    predecessorId: String(formData.get('predecessorId') ?? '') || null,
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  const clientId = parsed.data.clientId;
  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      // Mit Mandant: die Mandanten-Policy entscheidet. Ohne Mandant ist es eine
      // interne Aufgabe — die darf jede:r fuer sich und Kolleg:innen anlegen.
      if (clientId) {
        await assertClientAccessTx(tx, session, clientId);
        await assertClientInTenant(tx, clientId);
      }

      const r = await createReminderTx(tx, {
        tenantId,
        createdByStaff: staffId,
        clientId,
        dueDate: new Date(parsed.data.dueDate),
        subject: parsed.data.subject.trim(),
        notes: parsed.data.notes?.trim() || null,
        priority: parsed.data.priority,
        assigneeStaffIds: parsed.data.assigneeStaffIds,
        predecessorId: parsed.data.predecessorId ?? null,
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client_reminder.create',
        resourceType: 'client_reminder',
        resourceId: r.id,
        after: {
          clientId,
          dueDate: parsed.data.dueDate,
          subject: parsed.data.subject,
          assignees: parsed.data.assigneeStaffIds,
          predecessorId: parsed.data.predecessorId ?? null,
        },
      });
    },
    {
      revalidate: clientId
        ? [`/staff/clients/${clientId}`, '/staff/dashboard', '/staff/reminders']
        : ['/staff/dashboard', '/staff/reminders'],
    },
  );
}

/**
 * Klont eine Wiedervorlage — wahlweise als verkettete Nachfrage.
 *
 * Deckt zwei Wuensche mit einem Mechanismus ab: eine erledigte Aufgabe erneut
 * aufsetzen (Klon ohne Verweis) und die Rueckfrage zu einem gelieferten
 * Ergebnis (Folgestufe mit Verweis auf die vorige).
 */
export async function cloneReminderAction(input: {
  id: string;
  alsNachfrage: boolean;
  dueDate: string;
  subject?: string;
  notes?: string | null;
  assigneeStaffIds?: string[];
}): Promise<ActionResult & { id?: string }> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      alsNachfrage: z.boolean(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum YYYY-MM-DD'),
      subject: z.string().max(200).optional(),
      notes: z.string().max(2000).nullable().optional(),
      assigneeStaffIds: z.array(z.string().uuid()).max(20).optional(),
    })
    .safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const quelle = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: REMINDER_ACCESS_SELECT,
    });
    if (!quelle) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertReminderAccessTx(tx, session, quelle);

    const neu = await cloneReminderTx(
      tx,
      parsed.data.id,
      { tenantId, staffId },
      {
        alsNachfrage: parsed.data.alsNachfrage,
        dueDate: new Date(parsed.data.dueDate),
        ...(parsed.data.subject !== undefined ? { subject: parsed.data.subject } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        ...(parsed.data.assigneeStaffIds !== undefined
          ? { assigneeStaffIds: parsed.data.assigneeStaffIds }
          : {}),
      },
    );
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: parsed.data.alsNachfrage ? 'client_reminder.followup' : 'client_reminder.clone',
      resourceType: 'client_reminder',
      resourceId: neu.id,
      after: { quelle: parsed.data.id, clientId: quelle.clientId },
    });
    return { id: neu.id, clientId: quelle.clientId };
  });

  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/reminders');
  }
  return r;
}

/** Wortmeldung an einer Wiedervorlage (kurze Rueckfrage ohne neue Frist). */
export async function addReminderNoteAction(input: {
  id: string;
  body: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.string().uuid(), body: z.string().min(1).max(5000) })
    .safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: REMINDER_ACCESS_SELECT,
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertReminderAccessTx(tx, session, rem);
    await addReminderNoteTx(tx, {
      tenantId,
      reminderId: parsed.data.id,
      staffId,
      body: parsed.data.body,
    });
    return { clientId: rem.clientId };
  });
  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/reminders');
  }
  return r;
}

/** Zustaendige neu setzen (mehrere moeglich). Nur anlegende Person/Admin. */
export async function setReminderAssigneesAction(input: {
  id: string;
  staffIds: string[];
}): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.string().uuid(), staffIds: z.array(z.string().uuid()).min(1).max(20) })
    .safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: REMINDER_ACCESS_SELECT,
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertReminderAccessTx(tx, session, rem);
    if (!darfSteuern(session, rem)) {
      throw new ActionError('Nur die delegierende Person oder Admin/Partner darf umverteilen.');
    }
    const vorher = rem.assignees.map((a) => a.staffId);
    await setReminderAssigneesTx(tx, {
      tenantId,
      reminderId: parsed.data.id,
      staffIds: parsed.data.staffIds,
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client_reminder.assignees',
      resourceType: 'client_reminder',
      resourceId: parsed.data.id,
      before: { assignees: vorher },
      after: { assignees: parsed.data.staffIds },
    });
    return { clientId: rem.clientId };
  });
  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/reminders');
  }
  return r;
}

export async function markReminderDoneAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: { ...REMINDER_ACCESS_SELECT, subject: true, doneAt: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertReminderAccessTx(tx, session, rem);
    if (rem.doneAt) return { clientId: rem.clientId, notify: null };
    await tx.clientReminder.update({
      where: { id: parsed.data.id },
      data: { doneAt: new Date(), doneByStaff: staffId },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client_reminder.done',
      resourceType: 'client_reminder',
      resourceId: parsed.data.id,
    });

    // Nur bei echter Delegation — wer seine eigene Notiz abhakt, schickt sich
    // selbst keine Rueckmeldung.
    if (rem.createdByStaff === staffId) return { clientId: rem.clientId, notify: null };
    const me = await tx.staffUser.findUnique({
      where: { id: staffId },
      select: { fullName: true },
    });
    return {
      clientId: rem.clientId,
      notify: {
        tenantId,
        reminderId: parsed.data.id,
        staffId: rem.createdByStaff,
        clientId: rem.clientId,
        subject: rem.subject,
        doneByName: me?.fullName ?? 'Ein Mitarbeiter',
      },
    };
  });

  const geplant = r.ok ? r.notify : null;
  if (geplant) {
    const eingeplant = await scheduleReminderDoneNotification(geplant);
    if (!eingeplant) {
      // Fail-safe: sofort zustellen statt die Rueckmeldung zu verlieren.
      await withStaff(async (tx) => {
        await notify(tx, {
          tenantId: geplant.tenantId,
          staffId: geplant.staffId,
          kind: 'CLIENT_REMINDER_DONE',
          title: `Wiedervorlage erledigt: ${geplant.subject}`,
          body: `${geplant.doneByName} hat die von dir delegierte Wiedervorlage abgeschlossen.`,
          href: geplant.clientId ? `/staff/clients/${geplant.clientId}` : '/staff/reminders',
          resourceType: 'client_reminder',
          resourceId: geplant.reminderId,
        });
      });
    }
  }
  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/dashboard');
    revalidatePath('/staff/reminders');
  }
  return r;
}

/**
 * Holt eine erledigte Wiedervorlage zurueck.
 *
 * Bisher war die Checkbox eine Einbahnstrasse: ein Klick, und die Aufgabe war
 * aus der offenen Liste verschwunden — ohne Weg zurueck. Das Zurueckholen
 * entfernt zugleich die eingeplante Rueckmeldung: passiert es im
 * Ruecknahme-Fenster, erfaehrt die delegierende Person gar nichts davon.
 */
export async function reopenReminderAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: { ...REMINDER_ACCESS_SELECT, doneAt: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertReminderAccessTx(tx, session, rem);
    if (!rem.doneAt) return { clientId: rem.clientId };
    await tx.clientReminder.update({
      where: { id: parsed.data.id },
      data: { doneAt: null, doneByStaff: null },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client_reminder.reopen',
      resourceType: 'client_reminder',
      resourceId: parsed.data.id,
      before: { doneAt: rem.doneAt },
      after: { doneAt: null },
    });
    return { clientId: rem.clientId };
  });

  if (r.ok) await cancelReminderDoneNotification(parsed.data.id);
  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/dashboard');
    revalidatePath('/staff/reminders');
  }
  return r;
}

/**
 * Priorität anheben oder senken.
 *
 * Erlaubt fuer die delegierende Person (sie kennt die Dringlichkeit) sowie
 * Admin/Partner. Die zugewiesene Person soll sich ihre Aufgaben NICHT selbst
 * herunterstufen koennen — deshalb kein Recht allein aus der Zuweisung.
 */
export async function setReminderPriorityAction(input: {
  id: string;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
}): Promise<ActionResult> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: { ...REMINDER_ACCESS_SELECT, priority: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertReminderAccessTx(tx, session, rem);
    if (!darfSteuern(session, rem)) {
      throw new ActionError('Nur die delegierende Person oder Admin/Partner darf umpriorisieren.');
    }
    if (rem.priority === parsed.data.priority) return { clientId: rem.clientId };
    await tx.clientReminder.update({
      where: { id: parsed.data.id },
      data: { priority: parsed.data.priority },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client_reminder.priority',
      resourceType: 'client_reminder',
      resourceId: parsed.data.id,
      before: { priority: rem.priority },
      after: { priority: parsed.data.priority },
    });
    return { clientId: rem.clientId };
  });
  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/reminders');
  }
  return r;
}

// Mitarbeiter-Rücklauf: der/die Zugewiesene reicht das Recherche-Ergebnis direkt
// an der Delegations-Wiedervorlage ein → wird als RiskResearchResult der
// delegierten Markierung zugeordnet (Quelle=Mitarbeiter), landet im Recherche-Hub,
// und die Wiedervorlage gilt damit als erledigt (Aufgabe erfüllt).
const SubmitResearchResultSchema = z.object({
  reminderId: z.string().uuid(),
  clientId: z.string().uuid(),
  body: z.string().min(1, 'Bitte ein Ergebnis eingeben.').max(100_000),
});

export async function submitResearchResultAction(input: {
  reminderId: string;
  clientId: string;
  body: string;
}): Promise<ActionResult> {
  const parsed = SubmitResearchResultSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, parsed.data.clientId);
    await assertClientInTenant(tx, parsed.data.clientId);
    const reminder = await tx.clientReminder.findUnique({
      where: { id: parsed.data.reminderId },
      select: {
        id: true,
        clientId: true,
        createdByStaff: true,
        riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
      },
    });
    if (!reminder || reminder.clientId !== parsed.data.clientId)
      throw new Error('Wiedervorlage nicht gefunden.');
    const markingId = reminder.riskMarkings[0]?.id ?? null;
    const analysisId = reminder.riskMarkings[0]?.analysisId ?? null;
    if (!markingId) throw new Error('Diese Wiedervorlage ist kein Rechercheauftrag.');

    const me = await tx.staffUser.findUnique({
      where: { id: staffId },
      select: { fullName: true },
    });
    const result = await tx.riskResearchResult.create({
      data: {
        tenantId,
        markingId,
        title: 'Ergebnis (Mitarbeiter)',
        body: parsed.data.body.trim(),
        source: `Mitarbeiter: ${me?.fullName ?? 'unbekannt'}`,
        status: 'ZUGEORDNET',
      },
      select: { id: true },
    });

    // Eingereicht = Aufgabe erfüllt → Wiedervorlage erledigen.
    await tx.clientReminder.update({
      where: { id: reminder.id },
      data: { doneAt: new Date(), doneByStaff: staffId },
    });

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'risk.research.submitted',
      resourceType: 'risk_research_result',
      resourceId: result.id,
      after: { markingId, reminderId: reminder.id, source: 'Mitarbeiter' },
    });

    // Notify-on-arrival: der/die Delegierende wird informiert (nicht bei
    // Selbst-Zuweisung). Reuse REQUEST_RESPONDED (kein eigener Kind).
    if (reminder.createdByStaff && reminder.createdByStaff !== staffId) {
      await notify(tx, {
        tenantId,
        staffId: reminder.createdByStaff,
        kind: 'REQUEST_RESPONDED',
        title: `Rechercheergebnis eingereicht: ${me?.fullName ?? 'Mitarbeiter'}`,
        href: analysisId ? `/staff/clients/${parsed.data.clientId}/subsumtion/${analysisId}` : null,
        resourceType: 'risk_research_result',
        resourceId: result.id,
      });
    }
  });
  if (r.ok) {
    revalidatePath(`/staff/clients/${parsed.data.clientId}`);
    revalidatePath('/staff/dashboard');
  }
  return r;
}

export async function deleteReminderAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: { ...REMINDER_ACCESS_SELECT, subject: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertReminderAccessTx(tx, session, rem);
    await tx.clientReminder.delete({ where: { id: parsed.data.id } });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'client_reminder.delete',
      resourceType: 'client_reminder',
      resourceId: parsed.data.id,
      before: { subject: rem?.subject ?? null },
    });
    return { clientId: rem.clientId };
  });
  if (r.ok) {
    if (r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/dashboard');
  }
  return r;
}
