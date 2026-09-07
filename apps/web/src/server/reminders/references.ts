import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { extractTicketNumbers } from '@/lib/reminder-ticket-references';
import { accessibleRemindersWhereTx, lockReminderTx } from './access';

/** Append-only, deliberately without notifications or implicit access grants. */
export async function persistReminderReferencesTx(
  tx: TxClient,
  session: StaffSession,
  sourceReminderId: string,
  text: string,
): Promise<void> {
  const numbers = extractTicketNumbers(text);
  if (numbers.length === 0) return;
  await lockReminderTx(tx, session.user.tenantId, sourceReminderId);
  const readable = await accessibleRemindersWhereTx(tx, session);
  const source = await tx.clientReminder.findFirst({
    where: { AND: [readable, { id: sourceReminderId, archivedAt: null }] },
    select: { id: true },
  });
  if (!source) return;
  const targets = await tx.clientReminder.findMany({
    where: { AND: [readable, { ticketNumber: { in: numbers }, id: { not: sourceReminderId } }] },
    select: { id: true },
  });
  if (targets.length === 0) return;
  await tx.clientReminderReference.createMany({
    data: targets.map(({ id }) => ({
      tenantId: session.user.tenantId,
      sourceReminderId,
      targetReminderId: id,
    })),
    skipDuplicates: true,
  });
}
