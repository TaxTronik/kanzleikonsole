'use server';

import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
import { SETUP_DISMISSED_SETTING_KEY } from '@/server/setup/constants';

async function revalidateSetupViews(): Promise<void> {
  revalidatePath('/staff/dashboard');
  revalidatePath('/staff/admin');
}

export async function dismissSetupChecklistAction(): Promise<void> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return;

  const dismissedAt = new Date();
  await withTenantContext(guard.ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: {
        tenantId_key: { tenantId: guard.tenantId, key: SETUP_DISMISSED_SETTING_KEY },
      },
      create: {
        tenantId: guard.tenantId,
        key: SETUP_DISMISSED_SETTING_KEY,
        value: { dismissed: true, dismissedAt: dismissedAt.toISOString() },
        updatedBy: guard.staffId,
      },
      update: {
        value: { dismissed: true, dismissedAt: dismissedAt.toISOString() },
        updatedBy: guard.staffId,
      },
    });
    await evidenceService.record(tx, {
      tenantId: guard.tenantId,
      actorType: 'STAFF',
      actorId: guard.staffId,
      action: 'tenant.setup.dismiss',
      resourceType: 'tenant_setting',
      resourceId: SETUP_DISMISSED_SETTING_KEY,
      after: { dismissed: true },
    });
  });
  await revalidateSetupViews();
}

export async function restoreSetupChecklistAction(): Promise<void> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return;

  await withTenantContext(guard.ctx, async (tx) => {
    await tx.tenantSetting.deleteMany({
      where: { tenantId: guard.tenantId, key: SETUP_DISMISSED_SETTING_KEY },
    });
    await evidenceService.record(tx, {
      tenantId: guard.tenantId,
      actorType: 'STAFF',
      actorId: guard.staffId,
      action: 'tenant.setup.restore',
      resourceType: 'tenant_setting',
      resourceId: SETUP_DISMISSED_SETTING_KEY,
      after: { dismissed: false },
    });
  });
  await revalidateSetupViews();
}
