export function notificationTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Erkennt neue Notifications auch dann, wenn im selben Commit eine alte
 * ungelesene Aufgabe erledigt wird und die Gesamtzahl deshalb gleich bleibt.
 */
export function hasNewUnreadNotification(input: {
  previousUnread: number;
  previousLatestUnreadAt: number;
  nextUnread: number;
  nextLatestUnreadAt: string | null | undefined;
}): boolean {
  return (
    input.nextUnread > input.previousUnread ||
    notificationTimestamp(input.nextLatestUnreadAt) > input.previousLatestUnreadAt
  );
}
