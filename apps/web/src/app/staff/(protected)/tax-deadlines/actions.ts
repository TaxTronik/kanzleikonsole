'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { materializeTaxDeadlines } from '@/server/tax-deadlines/materialize';

export async function markDeadlineDoneAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  const id = z.string().uuid().parse(formData.get('id'));
  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.taxDeadline.findUnique({ where: { id } });
      if (!before) throw new Error('Termin nicht gefunden.');
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
  );

  revalidatePath('/staff/tax-deadlines');
}

export async function rematerializeAction(): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  const { tenantId, staffId } = session.user;

  await materializeTaxDeadlines(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    { systemStaffId: staffId },
  );

  revalidatePath('/staff/tax-deadlines');
}
