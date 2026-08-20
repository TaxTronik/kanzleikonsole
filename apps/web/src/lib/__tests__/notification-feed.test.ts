import { describe, expect, it } from 'vitest';

import {
  hasNewUnreadNotification,
  notificationTimestamp,
  shouldAcknowledgeCompletionOnCurrentPage,
} from '../notification-feed';

describe('Notification-Feed-Zuwachs', () => {
  it('erkennt einen neuen Eintrag trotz unverändertem Unread-Zähler', () => {
    const previousLatestUnreadAt = notificationTimestamp('2026-08-19T10:00:00.000Z');

    expect(
      hasNewUnreadNotification({
        previousUnread: 1,
        previousLatestUnreadAt,
        nextUnread: 1,
        nextLatestUnreadAt: '2026-08-19T10:05:00.000Z',
      }),
    ).toBe(true);
  });

  it('meldet das Ablesen oder einen unveränderten Feed nicht als neu', () => {
    const previousLatestUnreadAt = notificationTimestamp('2026-08-19T10:05:00.000Z');

    expect(
      hasNewUnreadNotification({
        previousUnread: 2,
        previousLatestUnreadAt,
        nextUnread: 1,
        nextLatestUnreadAt: '2026-08-19T10:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      hasNewUnreadNotification({
        previousUnread: 1,
        previousLatestUnreadAt,
        nextUnread: 1,
        nextLatestUnreadAt: '2026-08-19T10:05:00.000Z',
      }),
    ).toBe(false);
  });
});

describe('Notification-Abschluss auf der aktuellen Seite', () => {
  it('quittiert den erfolgreichen Audit-Test auf der bereits sichtbaren Audit-Seite', () => {
    expect(
      shouldAcknowledgeCompletionOnCurrentPage({
        kind: 'SYSTEM_AUDIT_OK',
        href: '/staff/admin/audit?verify=done',
        pathname: '/staff/admin/audit/',
      }),
    ).toBe(true);
  });

  it('quittiert weder Chain-Brüche noch Erfolge für eine andere Seite', () => {
    expect(
      shouldAcknowledgeCompletionOnCurrentPage({
        kind: 'SYSTEM_AUDIT_BREAK',
        href: '/staff/admin/audit',
        pathname: '/staff/admin/audit',
      }),
    ).toBe(false);
    expect(
      shouldAcknowledgeCompletionOnCurrentPage({
        kind: 'SYSTEM_AUDIT_OK',
        href: '/staff/admin/audit',
        pathname: '/staff/dashboard',
      }),
    ).toBe(false);
  });
});
