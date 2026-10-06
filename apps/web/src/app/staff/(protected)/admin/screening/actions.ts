'use server';
import { staffAction } from '@/server/actions/staff-action';
import { refreshEuSource } from '@/server/screening/service';
export async function refreshScreeningSourceAction() {
  return staffAction({
    guard: { module: 'sanctionsScreening', requireAdmin: true },
    run: (guard) => refreshEuSource(guard.ctx),
    revalidate: '/staff/admin/screening',
  });
}
