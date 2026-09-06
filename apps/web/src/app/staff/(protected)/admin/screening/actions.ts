'use server';
import { staffActionGuard } from '@/server/actions/staff-action';
import { toActionError } from '@/server/auth/rbac';
import { refreshEuSource } from '@/server/screening/service';
import { revalidatePath } from 'next/cache';
export async function refreshScreeningSourceAction() {
  const guard = await staffActionGuard({ module: 'sanctionsScreening', requireAdmin: true });
  if (!guard.ok) return guard;
  try {
    const result = await refreshEuSource(guard.ctx);
    revalidatePath('/staff/admin/screening');
    return { ok: true as const, ...result };
  } catch (e) {
    return toActionError(e);
  }
}
