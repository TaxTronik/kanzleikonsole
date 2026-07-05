'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { assertClientInTenant, assertStaffInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

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
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

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
        tenantId, actorType: 'STAFF', actorId: staffId,
        action: 'client_reminder.create',
        resourceType: 'client_reminder',
        resourceId: r.id,
        after: { clientId: parsed.data.clientId, dueDate: parsed.data.dueDate, subject: parsed.data.subject },
      });
    },
    { revalidate: [`/staff/clients/${parsed.data.clientId}`, '/staff/dashboard'] },
  );
}

export async function markReminderDoneAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const rem = await tx.clientReminder.findUnique({ where: { id: parsed.data.id }, select: { clientId: true } });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertClientAccessTx(tx, session, rem.clientId);
    await tx.clientReminder.update({
      where: { id: parsed.data.id },
      data: { doneAt: new Date(), doneByStaff: staffId },
    });
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'client_reminder.done',
      resourceType: 'client_reminder',
      resourceId: parsed.data.id,
    });
  });
  if (r.ok) {
    revalidatePath('/staff/clients', 'layout');
    revalidatePath('/staff/dashboard');
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
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    await assertClientAccessTx(tx, session, parsed.data.clientId);
    await assertClientInTenant(tx, parsed.data.clientId);
    const reminder = await tx.clientReminder.findUnique({
      where: { id: parsed.data.reminderId },
      select: {
        id: true, clientId: true, createdByStaff: true,
        riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
      },
    });
    if (!reminder || reminder.clientId !== parsed.data.clientId) throw new Error('Wiedervorlage nicht gefunden.');
    const markingId = reminder.riskMarkings[0]?.id ?? null;
    const analysisId = reminder.riskMarkings[0]?.analysisId ?? null;
    if (!markingId) throw new Error('Diese Wiedervorlage ist kein Rechercheauftrag.');

    const me = await tx.staffUser.findUnique({ where: { id: staffId }, select: { fullName: true } });
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
      tenantId, actorType: 'STAFF', actorId: staffId,
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
    const rem = await tx.clientReminder.findUnique({ where: { id: parsed.data.id }, select: { subject: true, clientId: true } });
    if (!rem) throw new ActionError('Wiedervorlage nicht gefunden.');
    await assertClientAccessTx(tx, session, rem.clientId);
    await tx.clientReminder.delete({ where: { id: parsed.data.id } });
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'client_reminder.delete',
      resourceType: 'client_reminder',
      resourceId: parsed.data.id,
      before: { subject: rem?.subject ?? null },
    });
  });
  if (r.ok) {
    revalidatePath('/staff/clients', 'layout');
    revalidatePath('/staff/dashboard');
  }
  return r;
}
