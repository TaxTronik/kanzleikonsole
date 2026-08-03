'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { assertClientInTenant, assertStaffInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx, isStaffAdmin } from '@/server/auth/rbac';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';
import {
  scheduleReminderDoneNotification,
  cancelReminderDoneNotification,
} from '@/server/jobs/reminder-done-queue';

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum YYYY-MM-DD'),
  subject: z.string().min(1).max(200),
  notes: z.string().max(2000).optional().or(z.literal('')),
  assigneeStaffId: z.string().uuid().nullable().optional(),
});

export async function createReminderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    dueDate: formData.get('dueDate'),
    subject: formData.get('subject'),
    notes: formData.get('notes') ?? '',
    assigneeStaffId: formData.get('assigneeStaffId') || null,
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, parsed.data.clientId);
      // R-2: Tenant-Sanity für clientId und assigneeStaffId
      await assertClientInTenant(tx, parsed.data.clientId);
      if (parsed.data.assigneeStaffId) {
        await assertStaffInTenant(tx, parsed.data.assigneeStaffId);
      }
      const r = await tx.clientReminder.create({
        data: {
          tenantId,
          clientId: parsed.data.clientId,
          dueDate: new Date(parsed.data.dueDate),
          subject: parsed.data.subject.trim(),
          notes: parsed.data.notes?.trim() || null,
          createdByStaff: staffId,
          assigneeStaffId: parsed.data.assigneeStaffId ?? staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client_reminder.create',
        resourceType: 'client_reminder',
        resourceId: r.id,
        after: {
          clientId: parsed.data.clientId,
          dueDate: parsed.data.dueDate,
          subject: parsed.data.subject,
        },
      });
    },
    { revalidate: [`/staff/clients/${parsed.data.clientId}`, '/staff/dashboard'] },
  );
}

/**
 * Erledigt eine Wiedervorlage.
 *
 * Die Rueckmeldung an die delegierende Person geht bewusst NICHT sofort raus,
 * sondern als verzoegerter Job (~10 s): Die Checkbox erledigt mit einem Klick,
 * und ein Fehlgriff soll folgenlos zuruecknehmbar sein. Eine bereits
 * zugestellte Benachrichtigung liesse sich nicht mehr einfangen.
 *
 * Scheitert das Einplanen (Redis weg), wird sofort benachrichtigt — die
 * Rueckmeldung still zu verlieren waere schlimmer als eine, die das
 * Ruecknahme-Fenster verpasst.
 */
export async function markReminderDoneAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({
      where: { id: parsed.data.id },
      select: { clientId: true, subject: true, createdByStaff: true, doneAt: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertClientAccessTx(tx, session, rem.clientId);
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
          href: `/staff/clients/${geplant.clientId}`,
          resourceType: 'client_reminder',
          resourceId: geplant.reminderId,
        });
      });
    }
  }
  if (r.ok && r.clientId) {
    revalidatePath(`/staff/clients/${r.clientId}`);
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
      select: { clientId: true, doneAt: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertClientAccessTx(tx, session, rem.clientId);
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
  if (r.ok && r.clientId) {
    revalidatePath(`/staff/clients/${r.clientId}`);
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
      select: { clientId: true, createdByStaff: true, priority: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertClientAccessTx(tx, session, rem.clientId);
    if (rem.createdByStaff !== staffId && !isStaffAdmin(session)) {
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
  if (r.ok && r.clientId) {
    revalidatePath(`/staff/clients/${r.clientId}`);
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
      select: { subject: true, clientId: true },
    });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertClientAccessTx(tx, session, rem.clientId);
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
  if (r.ok && r.clientId) {
    revalidatePath(`/staff/clients/${r.clientId}`);
    revalidatePath('/staff/dashboard');
  }
  return r;
}
