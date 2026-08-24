// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  processTaxDeadlineNotifications,
  type TaxDeadlineNotificationDeps,
} from '../tax-deadline-notification';

const NOW = new Date('2026-06-09T10:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'deadline-1',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    requestId: 'request-1',
    dueDate: new Date('2026-06-20T00:00:00.000Z'),
    autoRequestNotificationStatus: 'QUEUED',
    autoRequestNotificationAttemptCount: 0,
    autoRequestNotificationNextAttemptAt: NOW,
    request: {
      id: 'request-1',
      priority: 'NORMAL',
      status: 'OPEN',
      dueAt: new Date('2026-06-20T00:00:00.000Z'),
    },
    ...overrides,
  };
}

function harness(row = candidate()) {
  const findMany = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const tx = { taxDeadline: { updateMany } };
  const notifyAutomaticTaxRequestOpened = vi.fn().mockResolvedValue({
    ok: true,
    recipients: 1,
    attempted: 1,
    externalSideEffectOccurred: false,
    uncertainFailure: false,
  });
  const upsertStaffNotification = vi.fn().mockResolvedValue(undefined);
  const resolveFailureNotifications = vi.fn().mockResolvedValue(undefined);
  const logUncertainError = vi.fn();
  const deps = {
    db: { taxDeadline: { findMany } },
    runAtomic: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
    notifyAutomaticTaxRequestOpened,
    upsertStaffNotification,
    resolveFailureNotifications,
    logUncertainError,
  } as unknown as TaxDeadlineNotificationDeps;
  return {
    deps,
    findMany,
    updateMany,
    notifyAutomaticTaxRequestOpened,
    upsertStaffNotification,
    resolveFailureNotifications,
    logUncertainError,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('persistierter Auto-Request-Benachrichtigungsfluss', () => {
  it('setzt vor I/O einen UNKNOWN-Claim und wertet Erfolg nur als PROVIDER_ACCEPTED', async () => {
    const h = harness();

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.findMany.mock.calls[1]![0].where.OR).toEqual([
      {
        autoRequestNotificationStatus: 'QUEUED',
        autoRequestNotificationNextAttemptAt: { lte: NOW },
      },
      {
        autoRequestNotificationStatus: 'FAILED',
        autoRequestNotificationNextAttemptAt: { lte: NOW },
      },
    ]);
    expect(h.notifyAutomaticTaxRequestOpened).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      requestId: 'request-1',
      priority: 'NORMAL',
      dueAtIso: '2026-06-20T00:00:00.000Z',
    });
    expect(h.findMany.mock.calls[1]![0].select.request.select).not.toHaveProperty('title');
    expect(h.findMany.mock.calls[1]![0].select.request.select).not.toHaveProperty('description');
    expect(h.updateMany.mock.calls[0]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'UNKNOWN',
      autoRequestNotificationAttemptCount: { increment: 1 },
      autoRequestNotificationLastAttemptAt: NOW,
    });
    expect(h.updateMany.mock.calls[0]![0].where.request).toEqual({
      status: { in: ['OPEN', 'IN_PROGRESS'] },
    });
    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'PROVIDER_ACCEPTED',
      autoRequestNotificationAcceptedAt: NOW,
      autoRequestNotificationNextAttemptAt: null,
    });
    expect(h.resolveFailureNotifications).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-1',
      deadlineId: 'deadline-1',
    });
    expect(stats).toEqual({
      processed: 1,
      providerAccepted: 1,
      recipientsAccepted: 1,
      retryPending: 0,
      escalated: 0,
    });
  });

  it('persistiert einen eindeutigen Totalfehler als FAILED fuer denselben Request', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: false,
      recipients: 0,
      attempted: 2,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'FAILED',
      autoRequestNotificationNextAttemptAt: new Date('2026-06-09T10:04:00.000Z'),
      autoRequestNotificationEscalatedAt: null,
    });
    expect(h.updateMany.mock.calls[1]![0].where.requestId).toBe('request-1');
    expect(h.upsertStaffNotification).not.toHaveBeenCalled();
    expect(stats.retryPending).toBe(1);
  });

  it('beendet nach dem dritten eindeutigen Fehlschlag und eskaliert intern', async () => {
    const h = harness(
      candidate({
        autoRequestNotificationStatus: 'FAILED',
        autoRequestNotificationAttemptCount: 2,
      }),
    );
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: false,
      recipients: 0,
      attempted: 1,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'ESCALATED',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(h.upsertStaffNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'TAX_DEADLINE_NOTIFICATION_FAILED',
        resourceId: 'deadline-1',
        href: '/staff/requests/request-1',
      }),
    );
    expect(stats).toMatchObject({ retryPending: 0, escalated: 1 });
  });

  it('eskaliert fehlende Empfaenger ohne automatischen Retry', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: true,
      recipients: 0,
      attempted: 0,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'NO_RECIPIENT',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(stats).toMatchObject({ retryPending: 0, escalated: 1 });
  });

  it('behält ohne Mailkontakt trotz einmaligem n8n-Ereignis NO_RECIPIENT', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: true,
      recipients: 0,
      attempted: 0,
      externalSideEffectOccurred: true,
      uncertainFailure: false,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'NO_RECIPIENT',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(h.updateMany.mock.calls[1]![0].data.autoRequestNotificationLastError).toContain(
      'n8n-Ereignis wurde dennoch ausgelöst',
    );
    expect(stats).toMatchObject({ retryPending: 0, escalated: 1 });
  });

  it('eskaliert Teilannahme ohne automatischen Doppelversand', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: true,
      recipients: 1,
      attempted: 2,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'PARTIAL_FAILURE',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(stats).toMatchObject({
      recipientsAccepted: 1,
      retryPending: 0,
      escalated: 1,
    });
  });

  it('wiederholt nach bereits ausgelöstem externen Workflow keinen Mail-Totalfehler', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: false,
      recipients: 0,
      attempted: 2,
      externalSideEffectOccurred: true,
      uncertainFailure: false,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'PARTIAL_FAILURE',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(h.updateMany.mock.calls[1]![0].data.autoRequestNotificationLastError).toContain(
      'externer Workflow wurde bereits ausgelöst',
    );
    expect(stats).toMatchObject({ retryPending: 0, escalated: 1 });
  });

  it('behandelt Exceptions als UNKNOWN und sendet nicht blind erneut', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockRejectedValue(new Error('n8n timeout after SMTP'));

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'UNKNOWN',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(h.logUncertainError).toHaveBeenCalledOnce();
    expect(stats).toMatchObject({ retryPending: 0, escalated: 1 });
  });

  it('behandelt geschluckte SMTP-Exceptions als UNKNOWN statt als retrybaren Totalfehler', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: false,
      recipients: 0,
      attempted: 2,
      externalSideEffectOccurred: false,
      uncertainFailure: true,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'UNKNOWN',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(h.updateMany.mock.calls[1]![0].data.autoRequestNotificationLastError).toContain(
      'ohne explizite Provider-Ablehnung',
    );
    expect(stats).toMatchObject({ retryPending: 0, escalated: 1 });
  });

  it('bleibt bei unklarem SMTP-Ausgang trotz bereits ausgelöstem n8n-Workflow UNKNOWN', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: false,
      recipients: 0,
      attempted: 2,
      externalSideEffectOccurred: true,
      uncertainFailure: true,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'UNKNOWN',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(h.updateMany.mock.calls[1]![0].data.autoRequestNotificationLastError).toContain(
      'externer Workflow wurde bereits ausgelöst',
    );
    expect(stats).toMatchObject({ retryPending: 0, escalated: 1 });
  });

  it('bleibt bei bekannter Mindestannahme und weiterem unklarem SMTP-Ausgang UNKNOWN', async () => {
    const h = harness();
    h.notifyAutomaticTaxRequestOpened.mockResolvedValue({
      ok: true,
      recipients: 1,
      attempted: 2,
      externalSideEffectOccurred: false,
      uncertainFailure: true,
    });

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.updateMany.mock.calls[1]![0].data).toMatchObject({
      autoRequestNotificationStatus: 'UNKNOWN',
      autoRequestNotificationNextAttemptAt: null,
      autoRequestNotificationEscalatedAt: NOW,
    });
    expect(h.updateMany.mock.calls[1]![0].data.autoRequestNotificationLastError).toContain(
      '1 Mail-Einzelversuch',
    );
    expect(stats).toMatchObject({
      recipientsAccepted: 1,
      retryPending: 0,
      escalated: 1,
    });
  });

  it('eskaliert einen liegengebliebenen UNKNOWN-Claim statt erneut zu senden', async () => {
    const h = harness();
    h.findMany
      .mockReset()
      .mockResolvedValueOnce([
        { id: 'deadline-stranded', tenantId: 'tenant-1', requestId: 'request-stranded' },
      ])
      .mockResolvedValueOnce([]);

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.notifyAutomaticTaxRequestOpened).not.toHaveBeenCalled();
    expect(h.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'deadline-stranded',
          autoRequestNotificationStatus: 'UNKNOWN',
        }),
        data: expect.objectContaining({ autoRequestNotificationEscalatedAt: NOW }),
      }),
    );
    expect(stats.escalated).toBe(1);
  });

  it.each(['CLOSED', 'CANCELLED'] as const)(
    'versendet einen inzwischen %s Request nicht und terminalisiert die Vormerkung als ORPHANED',
    async (requestStatus) => {
      const row = candidate();
      row.request.status = requestStatus;
      const h = harness(row);

      const stats = await processTaxDeadlineNotifications(h.deps, {
        tenantId: 'tenant-1',
        now: NOW,
      });

      expect(h.notifyAutomaticTaxRequestOpened).not.toHaveBeenCalled();
      expect(h.updateMany).toHaveBeenCalledOnce();
      expect(h.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'deadline-1',
          tenantId: 'tenant-1',
          requestId: 'request-1',
          autoRequestNotificationStatus: 'QUEUED',
          autoRequestNotificationAttemptCount: 0,
          autoRequestNotificationNextAttemptAt: NOW,
          request: { status: { notIn: ['OPEN', 'IN_PROGRESS'] } },
        },
        data: { requestId: null },
      });
      expect(h.resolveFailureNotifications).toHaveBeenCalledWith(expect.anything(), {
        tenantId: 'tenant-1',
        deadlineId: 'deadline-1',
      });
      expect(stats).toMatchObject({ processed: 0, retryPending: 0, escalated: 0 });
    },
  );

  it('ignoriert ORPHANED auch dann fail-closed, wenn ein Adapter den Datensatz liefert', async () => {
    const h = harness(
      candidate({
        requestId: null,
        request: null,
        autoRequestNotificationStatus: 'ORPHANED',
        autoRequestNotificationAttemptCount: 1,
        autoRequestNotificationNextAttemptAt: null,
      }),
    );

    const stats = await processTaxDeadlineNotifications(h.deps, {
      tenantId: 'tenant-1',
      now: NOW,
    });

    expect(h.notifyAutomaticTaxRequestOpened).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ processed: 0, retryPending: 0, escalated: 0 });
  });
});
