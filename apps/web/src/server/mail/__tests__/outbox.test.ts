// F-08: Anstoß des Mail-Outbox-Workers nach dem Commit und Zustellstatus am Vorgang.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  add: vi.fn(),
  getWebQueue: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@/server/jobs/bullmq', () => ({
  getWebQueue: m.getWebQueue,
  WEB_QUEUE_TIMEOUT_MS: 2_000,
}));
vi.mock('@/server/logger', () => ({
  log: { warn: m.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { JOB_QUEUES, MAIL_OUTBOX_KICK_JOB_OPTIONS } from '@taxtronik/config/job-queues';
import type { TxClient } from '@taxtronik/db';
import { kickMailOutboxDelivery } from '../outbox';
import { loadMailDeliveryTx } from '../delivery-status';

beforeEach(() => {
  vi.clearAllMocks();
  m.getWebQueue.mockReturnValue({ add: m.add });
});

describe('kickMailOutboxDelivery', () => {
  it('reiht einen datenlosen Anstoß ohne BullMQ-Retry ein', async () => {
    m.add.mockResolvedValue({ id: 'job-1' });

    kickMailOutboxDelivery();

    await vi.waitFor(() => expect(m.add).toHaveBeenCalledOnce());
    expect(m.getWebQueue).toHaveBeenCalledWith(JOB_QUEUES.mailOutboxDeliver.name);
    expect(m.add).toHaveBeenCalledWith('kick', {}, MAIL_OUTBOX_KICK_JOB_OPTIONS);
  });

  it('wirft nie und protokolliert einen Redis-Fehler; der Minutentakt holt nach', async () => {
    m.add.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(() => kickMailOutboxDelivery()).not.toThrow();

    await vi.waitFor(() =>
      expect(m.warn).toHaveBeenCalledWith(
        { label: 'mail-outbox-deliver kick', err: 'ECONNREFUSED' },
        'fire-and-forget failed',
      ),
    );
  });
});

describe('loadMailDeliveryTx', () => {
  it('liest nur die angefragten Vorgänge und fasst je Vorgang zusammen', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        resourceId: 'invoice-1',
        purpose: 'invoice-sent',
        kind: 'DIRECT',
        status: 'PROVIDER_ACCEPTED',
        recipientsAttempted: 1,
        recipientsAccepted: 1,
        createdAt: new Date('2026-10-06T10:00:00Z'),
      },
      {
        resourceId: 'invoice-2',
        purpose: 'invoice-sent',
        kind: 'DIRECT',
        status: 'UNKNOWN',
        recipientsAttempted: 1,
        recipientsAccepted: 0,
        createdAt: new Date('2026-10-06T10:00:00Z'),
      },
    ]);
    const tx = { mailOutbox: { findMany } } as unknown as TxClient;

    const result = await loadMailDeliveryTx(tx, {
      resourceType: 'invoice',
      resourceIds: ['invoice-1', 'invoice-2'],
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resourceType: 'invoice', resourceId: { in: ['invoice-1', 'invoice-2'] } },
      }),
    );
    // Keine Inhalte oder Empfänger aus dem Auftrag.
    expect(findMany.mock.calls[0]![0].select).not.toHaveProperty('payload');
    expect(result.get('invoice-1')).toEqual([
      { purpose: 'invoice-sent', state: 'accepted', accepted: 1, attempted: 1 },
    ]);
    expect(result.get('invoice-2')?.[0]?.state).toBe('unknown');
  });

  it('fragt ohne Vorgänge nicht die Datenbank', async () => {
    const findMany = vi.fn();
    const tx = { mailOutbox: { findMany } } as unknown as TxClient;

    expect(await loadMailDeliveryTx(tx, { resourceType: 'request', resourceIds: [] })).toEqual(
      new Map(),
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
