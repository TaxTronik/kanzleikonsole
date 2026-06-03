'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isStaffAdmin, toActionError } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { emitN8nEvent } from '@/server/n8n/emit';
import { staffActionGuard, withStaff, type ActionResult } from '@/server/actions/staff-action';

export type { ActionResult };

function countWorkdays(start: Date, end: Date): number {
  let n = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

const VacationRequestSchema = z.object({
  startDate: z.string().date(),
  endDate: z.string().date(),
  reason: z.string().max(1000).optional().or(z.literal('')),
});

export async function createVacationRequestAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = VacationRequestSchema.safeParse({
    startDate: formData.get('startDate'),
    endDate: formData.get('endDate'),
    reason: formData.get('reason') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const startDate = new Date(parsed.data.startDate);
  const endDate = new Date(parsed.data.endDate);
  if (endDate < startDate) return { ok: false, error: 'Enddatum muss nach Startdatum liegen.' };

  const workdays = countWorkdays(startDate, endDate);

  let id: string;
  try {
    id = await withTenantContext(ctx, async (tx) => {
      const req = await tx.vacationRequest.create({
        data: {
          tenantId,
          staffId,
          startDate,
          endDate,
          workdays,
          reason: parsed.data.reason || null,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'vacation.request',
        resourceType: 'vacation_request',
        resourceId: req.id,
        after: { startDate: parsed.data.startDate, endDate: parsed.data.endDate, workdays },
      });
      return req.id;
    });
  } catch (e) {
    return toActionError(e);
  }

  // R-5: dediziertes Event. Vorher als staff.locked → n8n-Workflows mit
  // „Account-gesperrt"-Reflex (Slack-Alert etc.) wären hier fälschlich
  // ausgelöst.
  emitN8nEvent('staff.vacation_requested', {
    tenantId,
    requestId: id,
    staffId,
    workdays,
  });
  revalidatePath('/staff/absences');
  return { ok: true };
}

const DecideSchema = z.object({
  requestId: z.string().uuid(),
  approve: z.enum(['1', 'true']).optional(),
  note: z.string().max(1000).optional().or(z.literal('')),
});

export async function decideVacationAction(formData: FormData): Promise<void> {
  // Nur ADMIN/PARTNER darf fremde Urlaubsanträge entscheiden.
  const parsed = DecideSchema.safeParse({
    requestId: formData.get('requestId'),
    approve: formData.get('approve') ?? undefined,
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) return;

  const status = parsed.data.approve ? 'APPROVED' : 'REJECTED';

  await withStaff(
    async (tx, { tenantId, staffId }) => {
      const before = await tx.vacationRequest.findUnique({ where: { id: parsed.data.requestId } });
      if (!before) return;
      // 4-Augen-Prinzip (N7): ein ADMIN/PARTNER darf seinen eigenen
      // Urlaubsantrag nicht selbst entscheiden — auch in kleinen Kanzleien
      // muss die Genehmigung von einer anderen Person kommen.
      if (before.staffId === staffId) return;
      const updated = await tx.vacationRequest.update({
        where: { id: parsed.data.requestId },
        data: {
          status,
          decidedBy: staffId,
          decidedAt: new Date(),
          decisionNote: parsed.data.note || null,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: status === 'APPROVED' ? 'vacation.approve' : 'vacation.reject',
        resourceType: 'vacation_request',
        resourceId: updated.id,
        before: { status: before.status },
        after: { status: updated.status },
      });
    },
    { requireAdmin: true, revalidate: '/staff/absences' },
  );
}

export async function cancelVacationAction(formData: FormData): Promise<void> {
  // F6: UUID-Validation.
  const parsed = z.object({ requestId: z.string().uuid() }).safeParse({ requestId: formData.get('requestId') });
  if (!parsed.success) return;
  const { requestId: id } = parsed.data;

  await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      // N10: expliziter Tenant-Filter zusätzlich zur RLS — Defense in Depth.
      // Schützt auch dann, wenn RLS-Policy versehentlich gelockert wird, und
      // verhindert dass ein Bug im Tenant-Kontext fremde Mandanten-Daten
      // erwischt. Eigener Antrag (staffId) oder Admin darf canceln.
      const before = await tx.vacationRequest.findFirst({
        where: { id, tenantId },
      });
      if (!before) return;
      if (before.staffId !== staffId && !isStaffAdmin(session)) return;
      const updated = await tx.vacationRequest.update({
        where: { id },
        data: { status: 'CANCELLED' },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'vacation.cancel',
        resourceType: 'vacation_request',
        resourceId: updated.id,
        before: { status: before.status },
        after: { status: 'CANCELLED' },
      });
    },
    { revalidate: '/staff/absences' },
  );
}

const SickLeaveSchema = z.object({
  startDate: z.string().date(),
  endDate: z.string().date().optional().or(z.literal('')),
  notes: z.string().max(1000).optional().or(z.literal('')),
});

export async function createSickLeaveAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = SickLeaveSchema.safeParse({
    startDate: formData.get('startDate'),
    endDate: formData.get('endDate') ?? '',
    notes: formData.get('notes') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const sick = await tx.sickLeave.create({
        data: {
          tenantId,
          staffId,
          startDate: new Date(parsed.data.startDate),
          endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : null,
          notes: parsed.data.notes || null,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'sick.create',
        resourceType: 'sick_leave',
        resourceId: sick.id,
        after: { startDate: parsed.data.startDate, endDate: parsed.data.endDate || null },
      });
    },
    { revalidate: '/staff/absences' },
  );
}
