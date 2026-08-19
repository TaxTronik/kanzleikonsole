import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../tenant-context';
import {
  resolveNotificationsTx,
  sanitizeNotificationText,
  upsertNotificationTx,
} from '../notification';

function notificationTx(existing: { id: string } | null = null) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    notification: {
      findFirst: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue(undefined),
    },
  };
  return tx as unknown as TxClient & typeof tx;
}

describe('shared notification persistence', () => {
  it('removes control and bidi characters and neutralizes tag openers', () => {
    expect(sanitizeNotificationText('A\u0000\u202e<script>\nB\t')).toBe('A‹script>\nB\t');
  });

  it('sanitizes both fields when refreshing an unread notification', async () => {
    const tx = notificationTx({ id: 'existing-id' });

    await upsertNotificationTx(tx, {
      tenantId: 'tenant-id',
      staffId: 'staff-id',
      kind: 'SYSTEM_MAIL_FAILED',
      title: '<Titel>',
      body: 'Text\u2066<em>',
      href: '/staff',
      resourceType: 'mail',
      resourceId: 'mail-id',
    });

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.notification.update).toHaveBeenCalledWith({
      where: { id: 'existing-id' },
      data: {
        title: '‹Titel>',
        body: 'Text‹em>',
        href: '/staff',
        createdAt: expect.any(Date),
      },
    });
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('creates a normalized notification with explicit null defaults', async () => {
    const tx = notificationTx();

    await upsertNotificationTx(tx, {
      tenantId: 'tenant-id',
      kind: 'SYSTEM_BACKUP_FAILED',
      title: 'Backup',
    });

    expect(tx.notification.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-id',
        staffId: null,
        kind: 'SYSTEM_BACKUP_FAILED',
        title: 'Backup',
        body: null,
        href: null,
        resourceType: null,
        resourceId: null,
      },
    });
  });

  it('resolves all unread notifications for completed resources and legacy hrefs', async () => {
    const tx = notificationTx();
    tx.notification.updateMany.mockResolvedValue({ count: 3 });
    const resolvedAt = new Date('2026-08-19T12:00:00.000Z');

    const count = await resolveNotificationsTx(tx, {
      tenantId: 'tenant-id',
      resources: [{ resourceType: 'client_reminder', resourceId: 'reminder-id' }],
      hrefs: ['/staff/reminders/reminder-id', '/staff/reminders/reminder-id'],
      kinds: ['CLIENT_REMINDER_ASSIGNED', 'CLIENT_REMINDER_NOTE'],
      staffIds: ['staff-id'],
      resolvedAt,
    });

    expect(count).toBe(3);
    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-id',
        readAt: null,
        OR: [
          { resourceType: 'client_reminder', resourceId: 'reminder-id' },
          { href: '/staff/reminders/reminder-id' },
        ],
        kind: { in: ['CLIENT_REMINDER_ASSIGNED', 'CLIENT_REMINDER_NOTE'] },
        staffId: { in: ['staff-id'] },
      },
      data: { readAt: resolvedAt },
    });
  });

  it('does not issue an unscoped update without a resource or href', async () => {
    const tx = notificationTx();

    await expect(resolveNotificationsTx(tx, { tenantId: 'tenant-id' })).resolves.toBe(0);

    expect(tx.notification.updateMany).not.toHaveBeenCalled();
  });

  it('allows an explicit tenant-wide recovery only for named notification kinds', async () => {
    const tx = notificationTx();
    const resolvedAt = new Date('2026-08-19T12:30:00.000Z');

    await resolveNotificationsTx(tx, {
      tenantId: 'tenant-id',
      kinds: ['SYSTEM_BACKUP_FAILED'],
      tenantWide: true,
      resolvedAt,
    });

    expect(tx.notification.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-id',
        readAt: null,
        kind: { in: ['SYSTEM_BACKUP_FAILED'] },
      },
      data: { readAt: resolvedAt },
    });
  });
});
