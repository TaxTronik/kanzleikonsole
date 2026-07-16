import { redirect } from 'next/navigation';
import { staffAuth, type StaffSession } from './staff';
import { isStaffAdmin } from './rbac';

/** Central page guard for the staff surface. Redirects never return. */
export async function requireStaffPage(
  options: {
    admin?: boolean;
    deniedRedirect?: string;
  } = {},
): Promise<StaffSession> {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (options.admin && !isStaffAdmin(session)) {
    redirect(options.deniedRedirect ?? '/staff/dashboard');
  }
  return session;
}
