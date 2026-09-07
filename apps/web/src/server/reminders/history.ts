import type { TxClient } from '@taxtronik/db';

export interface ReminderHistoryOptions {
  commentsPage?: number;
  attachmentsPage?: number;
}

export function reminderPage(
  requested: number | undefined,
  total: number,
  pageSize: number,
): number {
  const page = Number.isSafeInteger(requested) ? Math.max(1, requested!) : 1;
  return Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
}

/** Called only after the root ticket ACL; latest history is page one. */
export async function loadReminderHistoryTx(
  tx: TxClient,
  tenantId: string,
  reminderId: string,
  options: ReminderHistoryOptions,
) {
  const commentsWhere = { tenantId, reminderId };
  const attachmentsWhere = { tenantId, reminderId, deletedAt: null };
  const commentsTotal = await tx.clientReminderNote.count({ where: commentsWhere });
  const attachmentsTotal = await tx.document.count({ where: attachmentsWhere });
  const commentsPageSize = 200;
  const attachmentsPageSize = 50;
  const commentsPage = reminderPage(options.commentsPage, commentsTotal, commentsPageSize);
  const attachmentsPage = reminderPage(
    options.attachmentsPage,
    attachmentsTotal,
    attachmentsPageSize,
  );
  const discussion = await tx.clientReminderNote.findMany({
    where: commentsWhere,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: commentsPageSize,
    skip: (commentsPage - 1) * commentsPageSize,
    select: { id: true, staffId: true, body: true, createdAt: true },
  });
  const attachments = await tx.document.findMany({
    where: attachmentsWhere,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: attachmentsPageSize,
    skip: (attachmentsPage - 1) * attachmentsPageSize,
    select: { id: true, title: true, mimeType: true, createdAt: true, ownerStaffId: true },
  });
  return {
    discussion: discussion.reverse(),
    attachments: attachments.reverse(),
    pagination: {
      commentsPage,
      commentsTotal,
      commentsPageSize,
      attachmentsPage,
      attachmentsTotal,
      attachmentsPageSize,
    },
  };
}
