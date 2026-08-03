// =============================================================================
// Zugriff auf eine Wiedervorlage.
//
// Zwei Fälle, seit der Mandantenbezug optional ist:
//
//   mit Mandant  → die bestehende Mandanten-Policy entscheidet
//                  (`assertClientAccessTx`: OPEN-Default, Vertraulich-Ventil).
//   ohne Mandant → interne Aufgabe. Hier greift KEINE Mandantenregel, also
//                  braucht es eine eigene: beteiligt sein (angelegt oder
//                  zugewiesen) oder Admin/Partner. Ohne diese Regel könnte
//                  jede Person im Tenant jede fremde interne Aufgabe lesen,
//                  abhaken und löschen — genau die Lücke, die das Öffnen des
//                  Mandantenfelds sonst aufreissen würde.
// =============================================================================

import { ForbiddenError, assertClientAccessTx, isStaffAdmin } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import type { TxClient } from '@taxtronik/db';

export interface ReminderAccessSubject {
  clientId: string | null;
  createdByStaff: string;
  assignees: Array<{ staffId: string }>;
}

/** Wirft `ForbiddenError`, wenn kein Zugriff besteht. */
export async function assertReminderAccessTx(
  tx: TxClient,
  session: StaffSession,
  reminder: ReminderAccessSubject,
): Promise<void> {
  if (reminder.clientId) {
    await assertClientAccessTx(tx, session, reminder.clientId);
    return;
  }
  if (istBeteiligt(session.user.staffId, reminder) || isStaffAdmin(session)) return;
  throw new ForbiddenError('Diese interne Aufgabe gehört dir nicht.');
}

/** Angelegt oder zugewiesen — reine Prüfung, ohne IO. */
export function istBeteiligt(staffId: string, reminder: ReminderAccessSubject): boolean {
  return (
    reminder.createdByStaff === staffId || reminder.assignees.some((a) => a.staffId === staffId)
  );
}

/**
 * Darf umpriorisieren / bearbeiten: die anlegende Person oder Admin/Partner.
 *
 * Die zugewiesene Person bewusst NICHT — sonst stuft man sich die eigenen
 * Aufgaben herunter oder schiebt die Frist.
 */
export function darfSteuern(session: StaffSession, reminder: { createdByStaff: string }): boolean {
  return reminder.createdByStaff === session.user.staffId || isStaffAdmin(session);
}

/** Prisma-Select, das `assertReminderAccessTx` mit allem Nötigen versorgt. */
export const REMINDER_ACCESS_SELECT = {
  clientId: true,
  createdByStaff: true,
  assignees: { select: { staffId: true } },
} as const;
