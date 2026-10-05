'use server';

import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { deleteTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { toActionError } from '@/server/auth/rbac';
import { evidenceService } from '@/server/container';
import { SETUP_DISMISSED_SETTING_KEY } from '@/server/setup/constants';

async function revalidateSetupViews(): Promise<void> {
  revalidatePath('/staff/dashboard');
  revalidatePath('/staff/admin');
}

export async function dismissSetupChecklistAction(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;

  const dismissedAt = new Date();
  try {
    await withTenantContext(guard.ctx, async (tx) => {
      await writeTenantSettingValue(tx, {
        tenantId: guard.tenantId,
        key: SETUP_DISMISSED_SETTING_KEY,
        value: { dismissed: true, dismissedAt: dismissedAt.toISOString() },
        updatedBy: guard.staffId,
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
  } catch (error) {
    return toActionError(error);
  }
  await revalidateSetupViews();
  return { ok: true };
}

export async function restoreSetupChecklistAction(
  _previous: ActionResult | null,
  _formData: FormData,
): Promise<ActionResult> {
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;

  try {
    await withTenantContext(guard.ctx, async (tx) => {
      await deleteTenantSettingValue(tx, guard.tenantId, SETUP_DISMISSED_SETTING_KEY);
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
  } catch (error) {
    return toActionError(error);
  }
  await revalidateSetupViews();
  return { ok: true };
}
