import { describe, expect, it } from 'vitest';

import { hasNewUnreadNotification, notificationTimestamp } from '../notification-feed';

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
