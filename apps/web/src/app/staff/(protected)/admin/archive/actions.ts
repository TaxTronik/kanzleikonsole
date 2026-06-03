'use server';

import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { getAuditRotateQueue } from '@/server/jobs/audit-rotate-queue';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

export async function triggerAuditRotateAction(): Promise<void> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) throw new ActionError(g.error);
  const { tenantId, staffId, ctx } = g;

  // BullMQ-Job direkt einreihen — der Worker rotiert nur diesen Tenant.
  // Connection ist modulweiter Singleton (siehe audit-rotate-queue.ts), kein
  // per-Click-Connect/Disconnect mehr.
  await getAuditRotateQueue().add('audit-rotate', { tenantId });

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'audit.rotate.trigger',
      resourceType: 'audit_archive',
      after: { triggeredManually: true },
    });
  });

  revalidatePath('/staff/admin/archive');
}
