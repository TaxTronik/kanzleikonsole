import { redirect } from 'next/navigation';
import { staffAuth, type StaffSession } from './staff';
import { isStaffAdmin } from './rbac';

/** Ziel innerhalb der Staff-Oberfläche, z. B. `/staff/poa`. */
export type StaffPagePath = `/staff/${string}`;

/**
 * Nur feste Pfade der Staff-Oberfläche: `/staff` plus Segmente aus Buchstaben,
 * Ziffern, `_` und `-`. Damit sind fremde Hosts (`//host`, `https://…`),
 * Backslashes, Punktsegmente, Query und Fragment ausgeschlossen.
 */
const STAFF_PAGE_PATH = /^\/staff(?:\/[A-Za-z0-9_-]+)+$/;

export function isStaffPagePath(target: string): target is StaffPagePath {
  return STAFF_PAGE_PATH.test(target);
}

/** Central page guard for the staff surface. Redirects never return. */
export async function requireStaffPage(
  options: {
    admin?: boolean;
    deniedRedirect?: StaffPagePath;
  } = {},
): Promise<StaffSession> {
  // Vor jeder Sitzungsprüfung: ein ungültiges Ziel ist ein Programmierfehler
  // und soll auch bei berechtigten Aufrufen sofort auffallen.
  if (options.deniedRedirect !== undefined && !isStaffPagePath(options.deniedRedirect)) {
    throw new Error(`deniedRedirect muss ein Pfad unter /staff/ sein: ${options.deniedRedirect}`);
  }
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (options.admin && !isStaffAdmin(session)) {
    redirect(options.deniedRedirect ?? '/staff/dashboard');
  }
  return session;
}
