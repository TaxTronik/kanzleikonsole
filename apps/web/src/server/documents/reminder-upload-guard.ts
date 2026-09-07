import type { TxClient } from '@taxtronik/db';
import { ForbiddenError } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import { assertReminderAccessTx, REMINDER_ACCESS_SELECT } from '@/server/reminders/access';

export class ReminderUploadError extends Error {
  constructor() {
    super('Wiedervorlage nicht verfügbar oder bereits archiviert.');
  }
}

/**
 * Fachkatalog: REMINDER-TICKET-001, ACCESS-CLIENT-MODE-001
 * Vor dem Store-Write und nochmals in der Dokument-Finalisierung prüfen.
 * Der Row-Lock serialisiert den letzten Check mit Archivierung/Zuweisung.
 */
export async function assertReminderUploadTx(
  tx: TxClient,
  session: StaffSession,
  reminderId: string,
  clientId: string | null,
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM client_reminder
    WHERE id = ${reminderId}::uuid AND tenant_id = ${session.user.tenantId}::uuid
    FOR NO KEY UPDATE
  `;
  const reminder = await tx.clientReminder.findFirst({
    where: { id: reminderId, tenantId: session.user.tenantId },
    select: { ...REMINDER_ACCESS_SELECT, archivedAt: true },
  });
  if (!reminder || reminder.clientId !== clientId) throw new ReminderUploadError();
  try {
    await assertReminderAccessTx(tx, session, reminder);
  } catch (error) {
    if (error instanceof ForbiddenError) throw new ReminderUploadError();
    throw error;
  }
  if (reminder.archivedAt) throw new ReminderUploadError();
}
