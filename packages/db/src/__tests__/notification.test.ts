import { describe, expect, it, vi } from 'vitest';

import type { TxClient } from '../tenant-context';
import {
  insertNotificationsTx,
  resolveClientContactNotificationsTx,
  resolveNotificationsTx,
  sanitizeNotificationText,
  upsertNotificationTx,
  upsertNotificationsTx,
  type NotificationUpsertInput,
} from '../notification';

function notificationTx(existing: { id: string } | null = null) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([{ actorType: 'SYSTEM' }]),
    notification: {
      findFirst: vi.fn().mockResolvedValue(existing),
      update: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi
        .fn()
        .mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
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
        clientId: null,
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

  it('delegiert CLIENT_CONTACT-Upserts an den write-only DB-Pfad', async () => {
    const tx = notificationTx();
    tx.$queryRaw
      .mockResolvedValueOnce([{ actorType: 'CLIENT_CONTACT' }])
      .mockResolvedValueOnce([{ upsertClientContactNotification: true }]);

    await upsertNotificationTx(tx, {
      tenantId: 'tenant-id',
      staffId: 'staff-id',
      kind: 'APPOINTMENT_REQUESTED',
      title: '<Terminanfrage>',
      body: 'Bitte <intern> bearbeiten',
      href: '/staff/calendar',
      resourceType: 'appointment_request',
      resourceId: 'request-id',
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.notification.findFirst).not.toHaveBeenCalled();
    expect(tx.notification.update).not.toHaveBeenCalled();
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('delegiert Portal-Auflösungen ohne Notification-Lesezugriff an die DB', async () => {
    const tx = notificationTx();
    tx.$queryRaw.mockResolvedValue([{ resolvedCount: 2 }]);

    await expect(
      resolveClientContactNotificationsTx(tx, {
        tenantId: 'tenant-id',
        resourceType: 'appointment_request',
        resourceId: 'request-id',
        resolvedAt: new Date('2026-08-23T09:00:00.000Z'),
      }),
    ).resolves.toBe(2);

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
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

// R-11: gebündelter Worker-Pfad (DB-Äquivalenz: notification-batch.test.ts).
describe('upsertNotificationsTx / insertNotificationsTx', () => {
  const base = { tenantId: 'tenant-id', kind: 'SCREENING_REVIEW' as const, href: '/staff' };
  const input = (staffId: string, title = 'Hinweis'): NotificationUpsertInput => ({
    ...base,
    staffId,
    title,
    body: 'Text',
    resourceType: 'tenant',
    resourceId: 'tenant-id',
  });

  it('sperrt alle Schlüssel sortiert in einem Statement, liest Bestände einmal, legt Rest gebündelt an', async () => {
    const tx = notificationTx();
    tx.notification.findMany.mockResolvedValue([
      {
        id: 'existing-b',
        tenantId: 'tenant-id',
        clientId: null,
        staffId: 'staff-b',
        kind: 'SCREENING_REVIEW',
        resourceType: 'tenant',
        resourceId: 'tenant-id',
      },
    ]);

    const result = await upsertNotificationsTx(tx, [
      input('staff-c', '<c>'),
      input('staff-b', 'b\u202e'),
      input('staff-a'),
    ]);

    expect(result).toEqual({ created: 2, updated: 1 });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    const lockKeys = tx.$executeRaw.mock.calls[0]!.slice(1)[0] as string[];
    expect(lockKeys).toEqual([
      'notify:tenant-id:staff-a:SCREENING_REVIEW:tenant:tenant-id',
      'notify:tenant-id:staff-b:SCREENING_REVIEW:tenant:tenant-id',
      'notify:tenant-id:staff-c:SCREENING_REVIEW:tenant:tenant-id',
    ]);
    expect(tx.notification.findMany).toHaveBeenCalledOnce();
    expect(tx.notification.findMany.mock.calls[0]![0].where.readAt).toBeNull();
    expect(tx.notification.update).toHaveBeenCalledWith({
      where: { id: 'existing-b' },
      data: { title: 'b', body: 'Text', href: '/staff', createdAt: expect.any(Date) },
    });
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ staffId: 'staff-a', title: 'Hinweis', clientId: null }),
        expect.objectContaining({ staffId: 'staff-c', title: '‹c>' }),
      ],
      skipDuplicates: true,
    });
  });

  it('gleicht einen explizit gesetzten Mandantenscope ab und zählt doppelte Schlüssel einmal', async () => {
    const tx = notificationTx();
    tx.notification.findMany.mockResolvedValue([
      {
        id: 'other-client',
        tenantId: 'tenant-id',
        clientId: 'client-2',
        staffId: 'staff-a',
        kind: 'SCREENING_REVIEW',
        resourceType: 'tenant',
        resourceId: 'tenant-id',
      },
    ]);

    const result = await upsertNotificationsTx(tx, [
      { ...input('staff-a', 'erst'), clientId: 'client-1' },
      { ...input('staff-a', 'zuletzt'), clientId: 'client-1' },
    ]);

    // Die offene Notification gehört zu einem anderen Mandanten → neu anlegen,
    // und zwar einmal mit der letzten Eingabe.
    expect(result).toEqual({ created: 1, updated: 0 });
    expect(tx.notification.update).not.toHaveBeenCalled();
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ clientId: 'client-1', title: 'zuletzt' })],
      skipDuplicates: true,
    });
  });

  it('arbeitet große Mengen in Abschnitten zu 250 ab', async () => {
    const tx = notificationTx();
    const inputs = Array.from({ length: 600 }, (_, i) =>
      input(`staff-${String(i).padStart(3, '0')}`),
    );

    await expect(upsertNotificationsTx(tx, inputs)).resolves.toEqual({ created: 600, updated: 0 });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(tx.notification.findMany).toHaveBeenCalledTimes(3);
    expect(tx.notification.createMany.mock.calls.map((call) => call[0].data.length)).toEqual([
      250, 250, 100,
    ]);
  });

  it('macht ohne Eingaben keine Abfrage', async () => {
    const tx = notificationTx();

    await expect(upsertNotificationsTx(tx, [])).resolves.toEqual({ created: 0, updated: 0 });
    await expect(insertNotificationsTx(tx, [])).resolves.toBe(0);

    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('verweigert die gebündelten Pfade im Portal-Kontext', async () => {
    const tx = notificationTx();
    tx.$queryRaw.mockResolvedValue([{ actorType: 'CLIENT_CONTACT' }]);

    await expect(upsertNotificationsTx(tx, [input('staff-a')])).rejects.toThrow(
      'NOTIFICATION_BATCH_CLIENT_CONTACT',
    );
    await expect(insertNotificationsTx(tx, [input('staff-a')])).rejects.toThrow(
      'NOTIFICATION_BATCH_CLIENT_CONTACT',
    );
    expect(tx.notification.createMany).not.toHaveBeenCalled();
  });

  it('insertNotificationsTx legt jede Eingabe sanitisiert an und überspringt Index-Konflikte', async () => {
    const tx = notificationTx();
    tx.notification.createMany.mockResolvedValue({ count: 1 });

    await expect(
      insertNotificationsTx(tx, [input('staff-a', '<a>'), input('staff-b')]),
    ).resolves.toBe(1);

    expect(tx.notification.findMany).not.toHaveBeenCalled();
    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ staffId: 'staff-a', title: '‹a>' }),
        expect.objectContaining({ staffId: 'staff-b', title: 'Hinweis' }),
      ],
      skipDuplicates: true,
    });
  });
});
