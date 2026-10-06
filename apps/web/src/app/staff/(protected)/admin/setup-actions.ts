'use server';

import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { deleteTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { staffAction, type ActionResult } from '@/server/actions/staff-action';
import { SETUP_DISMISSED_SETTING_KEY } from '@/server/setup/constants';
import { audit } from '@/server/actions/audit';

async function revalidateSetupViews(): Promise<void> {
  revalidatePath('/staff/dashboard');
  revalidatePath('/staff/admin');
}

export async function dismissSetupChecklistAction(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (guard) => {
      const dismissedAt = new Date();
      await withTenantContext(guard.ctx, async (tx) => {
        await writeTenantSettingValue(tx, {
          tenantId: guard.tenantId,
          key: SETUP_DISMISSED_SETTING_KEY,
          value: { dismissed: true, dismissedAt: dismissedAt.toISOString() },
          updatedBy: guard.staffId,
        });
        await audit(tx, guard, {
          action: 'tenant.setup.dismiss',
          resourceType: 'tenant_setting',
          resourceId: SETUP_DISMISSED_SETTING_KEY,
          after: { dismissed: true },
        });
      });
      await revalidateSetupViews();
    },
  });
}

export async function restoreSetupChecklistAction(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (guard) => {
      await withTenantContext(guard.ctx, async (tx) => {
        await deleteTenantSettingValue(tx, guard.tenantId, SETUP_DISMISSED_SETTING_KEY);
        await audit(tx, guard, {
          action: 'tenant.setup.restore',
          resourceType: 'tenant_setting',
          resourceId: SETUP_DISMISSED_SETTING_KEY,
          after: { dismissed: false },
        });
      });
      await revalidateSetupViews();
    },
  });
}
