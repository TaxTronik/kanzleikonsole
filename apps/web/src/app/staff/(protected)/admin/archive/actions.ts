'use server';

import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { getAuditRotateQueue } from '@/server/jobs/audit-rotate-queue';

export async function triggerAuditRotateAction(): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) throw new Error('Nicht eingeloggt.');
  if (!isStaffAdmin(session)) {
    throw new Error('Nur ADMIN/PARTNER.');
  }
  const { tenantId, staffId } = session.user;

  // BullMQ-Job direkt einreihen — der Worker rotiert nur diesen Tenant.
  // Connection ist modulweiter Singleton (siehe audit-rotate-queue.ts), kein
  // per-Click-Connect/Disconnect mehr.
  await getAuditRotateQueue().add('audit-rotate', { tenantId });

  await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) => {
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
