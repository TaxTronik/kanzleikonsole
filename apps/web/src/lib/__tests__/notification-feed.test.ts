import { describe, expect, it } from 'vitest';

import {
  hasNewUnreadNotification,
  newUnreadNotifications,
  notificationTimestamp,
  shouldAcknowledgeCompletionOnCurrentPage,
} from '../notification-feed';

describe('newUnreadNotifications (P-08: Ziele eines Zuwachses)', () => {
  const items = [
    { id: 'neu', createdAt: '2026-08-19T10:10:00.000Z', readAt: null },
    { id: 'alt-ungelesen', createdAt: '2026-08-19T09:00:00.000Z', readAt: null },
    { id: 'gelesen', createdAt: '2026-08-19T10:20:00.000Z', readAt: '2026-08-19T10:21:00.000Z' },
  ];

  it('liefert nur ungelesene Einträge, die jünger als der bisherige Stand sind', () => {
    const before = notificationTimestamp('2026-08-19T10:00:00.000Z');
    expect(newUnreadNotifications(items, before).map((item) => item.id)).toEqual(['neu']);
  });

  it('fällt ohne jüngeren Eintrag auf alle ungelesenen zurück', () => {
    const before = notificationTimestamp('2026-08-19T11:00:00.000Z');
    expect(newUnreadNotifications(items, before).map((item) => item.id)).toEqual([
      'neu',
      'alt-ungelesen',
    ]);
  });
});

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
