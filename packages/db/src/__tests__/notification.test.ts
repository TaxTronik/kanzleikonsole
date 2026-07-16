import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../tenant-context';
import { sanitizeNotificationText, upsertNotificationTx } from '../notification';

function notificationTx(existing: { id: string } | null = null) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    notification: {
      findFirst: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockResolvedValue(undefined),
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
});
