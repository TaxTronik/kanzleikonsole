'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { evidenceService } from '@/server/container';
import { materializeTaxDeadlines } from '@/server/tax-deadlines/materialize';
import { staffActionGuard, withStaff, ActionError } from '@/server/actions/staff-action';

export async function markDeadlineDoneAction(formData: FormData): Promise<void> {
  const id = z.string().uuid().parse(formData.get('id'));

  await withStaff(
    async (tx, { tenantId, staffId }) => {
      const before = await tx.taxDeadline.findUnique({ where: { id } });
      if (!before) throw new ActionError('Termin nicht gefunden.');
      await tx.taxDeadline.update({
        where: { id },
        data: { status: 'DONE', completedAt: new Date(), completedByStaff: staffId },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'tax_deadline.complete',
        resourceType: 'tax_deadline',
        resourceId: id,
        before: { status: before.status },
        after: { status: 'DONE' },
      });
    },
    { revalidate: '/staff/tax-deadlines' },
  );
}

export async function markDeadlinesDoneAction(formData: FormData): Promise<void> {
  const ids = z
    .array(z.string().uuid())
    .parse(formData.getAll('ids').map((v) => String(v)));
  if (ids.length === 0) return;

  await withStaff(
    async (tx, { tenantId, staffId }) => {
      // Nur offene Termine schließen — bereits erledigte/übersprungene nicht
      // anfassen (kein doppelter Audit-Eintrag, idempotent bei Mehrfachklick).
      const toClose = await tx.taxDeadline.findMany({
        where: { id: { in: ids }, status: { notIn: ['DONE', 'SKIPPED'] } },
        select: { id: true, status: true },
      });
      if (toClose.length === 0) return;
      await tx.taxDeadline.updateMany({
        where: { id: { in: toClose.map((t) => t.id) } },
        data: { status: 'DONE', completedAt: new Date(), completedByStaff: staffId },
      });
      for (const t of toClose) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'tax_deadline.complete',
          resourceType: 'tax_deadline',
          resourceId: t.id,
          before: { status: t.status },
          after: { status: 'DONE' },
        });
      }
    },
    { revalidate: '/staff/tax-deadlines' },
  );
}

export async function rematerializeAction(): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return;

  await materializeTaxDeadlines(g.ctx, { systemStaffId: g.staffId });

  revalidatePath('/staff/tax-deadlines');
}
