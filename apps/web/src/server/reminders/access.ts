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

import {
  ForbiddenError,
  assertClientAccessTx,
  isStaffAdmin,
  accessibleClientsWhereFor,
} from '@/server/auth/rbac';
import { ActionError } from '@/server/actions/action-error';
import type { StaffSession } from '@/server/auth/staff';
import type { TxClient } from '@taxtronik/db';
import type { Prisma as PrismaTypes } from '@prisma/client';

/** REMINDER-TICKET-001: Filter before counting, pagination or projecting related titles. */
export async function accessibleRemindersWhereTx(
  tx: TxClient,
  session: StaffSession,
): Promise<PrismaTypes.ClientReminderWhereInput> {
  const { tenantId, staffId } = session.user;
  const clients = await accessibleClientsWhereFor(tx, session);
  return {
    tenantId,
    OR: [
      { client: { is: { tenantId, ...clients } } },
      {
        clientId: null,
        ...(isStaffAdmin(session)
          ? {}
          : {
              OR: [{ createdByStaff: staffId }, { assignees: { some: { staffId } } }],
            }),
      },
    ],
  };
}

/** Serializes ticket mutations with archive and document finalization. */
export async function lockReminderTx(tx: TxClient, tenantId: string, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM client_reminder
    WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid FOR NO KEY UPDATE`;
}

export function assertReminderNotArchived(reminder: { archivedAt: Date | null }): void {
  if (reminder.archivedAt) throw new ActionError('Archivierte Tickets bitte zuerst zurückholen.');
}

export function assertReminderActor(
  session: StaffSession,
  tenantId: string,
  staffId: string,
): void {
  if (session.user.tenantId !== tenantId || session.user.staffId !== staffId) {
    throw new ForbiddenError('Ungültiger Ticket-Akteur.');
  }
}

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
  archivedAt: true,
  clientId: true,
  createdByStaff: true,
  assignees: { select: { staffId: true } },
} as const;
