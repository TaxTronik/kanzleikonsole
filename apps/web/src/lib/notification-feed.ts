export function notificationTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const CURRENT_PAGE_COMPLETION_KINDS = new Set(['SYSTEM_AUDIT_OK']);

function normalizedInternalPath(value: string | null | undefined): string | null {
  if (!value?.startsWith('/') || value.startsWith('//')) return null;
  const path = value.split(/[?#]/, 1)[0]!.replace(/\/+$/, '');
  return path || '/';
}

/**
 * Abschlussmeldungen, deren Ergebnis auf der gerade sichtbaren Zielseite
 * bereits dargestellt wird, brauchen keinen zweiten Toast. Handlungs- und
 * Fehlermeldungen werden bewusst nie allein durch den Seitenbesuch quittiert.
 */
export function shouldAcknowledgeCompletionOnCurrentPage(input: {
  kind: string;
  href: string | null | undefined;
  pathname: string;
}): boolean {
  return (
    CURRENT_PAGE_COMPLETION_KINDS.has(input.kind) &&
    normalizedInternalPath(input.href) === normalizedInternalPath(input.pathname)
  );
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
