import type { TxClient } from '@taxtronik/db';

export interface UnreadNotificationSummary {
  unread: number;
  latestUnreadAt: string | null;
}

/** Zähler der Glocke: persönliche plus tenantweite (staffId null) ungelesene Einträge. */
export async function readUnreadNotificationSummaryTx(
  tx: TxClient,
  staffId: string,
): Promise<UnreadNotificationSummary> {
  const summary = await tx.notification.aggregate({
    where: { OR: [{ staffId }, { staffId: null }], readAt: null },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  return {
    unread: summary._count._all,
    latestUnreadAt: summary._max.createdAt?.toISOString() ?? null,
  };
}
