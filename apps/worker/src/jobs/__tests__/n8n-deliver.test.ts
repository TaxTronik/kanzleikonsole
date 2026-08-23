// =============================================================================
// Unit-Tests: workflow-spezifische n8n-Deliveries, DB-Lease und Aggregation
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LEASE_TOKEN = '00000000-0000-4000-8000-000000000099';

const h = vi.hoisted(() => {
  class SsrfGuardError extends Error {
    constructor(
      public reason: string,
      message: string,
    ) {
      super(message);
      this.name = 'SsrfGuardError';
    }
  }
  const tx = {
    $queryRaw: vi.fn(),
    n8nConnection: { findUnique: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
    n8nOutbox: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    n8nDelivery: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    tx,
    env: { N8N_WEBHOOK_BASE_URL: '', N8N_HMAC_SECRET: '' },
    SsrfGuardError,
    safeFetch: vi.fn(),
    isAllowedN8nEvent: vi.fn(),
    signOutboundN8n: vi.fn(),
    decryptSecret: vi.fn(),
    looksEncrypted: vi.fn(),
    responseCancel: vi.fn(),
    deliveryMode: 'production',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    prismaOwner: {
      ...tx,
      $transaction: vi.fn(),
    },
  };
});

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
  randomUUID: () => '00000000-0000-4000-8000-000000000099',
}));
vi.mock('bullmq', () => import('./mocks/bullmq'));
vi.mock('../../queues', () => ({ connection: {} }));
vi.mock('../../prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('../../logger', () => ({ log: h.log }));
vi.mock('@taxtronik/config', () => ({
  env: h.env,
  get n8nDeliveryMode() {
    return h.deliveryMode;
  },
}));
vi.mock('@taxtronik/n8n-shared', () => ({
  isAllowedN8nEvent: h.isAllowedN8nEvent,
  signOutboundN8n: h.signOutboundN8n,
}));
vi.mock('@taxtronik/crypto', () => ({
  decryptSecret: h.decryptSecret,
  looksEncrypted: h.looksEncrypted,
}));
vi.mock('@taxtronik/http-utils', () => ({
  safeFetch: h.safeFetch,
  SsrfGuardError: h.SsrfGuardError,
}));

import { processors, queueAdds, queueCloses, resetQueueRecords } from './mocks/bullmq';
import '../n8n-deliver';

const NOW = new Date('2026-07-14T12:00:00.000Z');
const CONNECTION_ID = '00000000-0000-4000-8000-000000000010';
const DELIVERY = {
  id: 'delivery-1',
  tenantId: 'tenant-1',
  outboxId: 'outbox-1',
  endpointId: 'endpoint-1',
  connectionIdSnapshot: CONNECTION_ID,
  endpointNameSnapshot: 'Request geöffnet',
  targetUrl: 'https://n8n.example.com/webhook/request-opened',
  status: 'PROCESSING',
  leaseToken: LEASE_TOKEN,
  attempts: 0,
  firstAttemptAt: null,
  endpoint: {
    enabled: true,
    connectionId: CONNECTION_ID,
    productionUrl: 'https://n8n.example.com/webhook/request-opened',
    testUrl: 'https://n8n.example.com/webhook-test/request-opened',
    subscriptions: [{ event: 'request.opened' }],
  },
  outbox: {
    id: 'outbox-1',
    tenantId: 'tenant-1',
    event: 'request.opened',
    payload: { requestId: 'request-1' },
    occurredAt: new Date('2026-07-14T11:55:00.000Z'),
  },
};

function runDelivery(deliveryId = 'delivery-1', attemptsMade = 0, attempts = 6): Promise<unknown> {
  return processors.get('n8n-deliver')!({
    data: { deliveryId },
    attemptsMade,
    opts: { attempts },
  });
}

function runLegacy(outboxId = 'outbox-legacy'): Promise<unknown> {
  return processors.get('n8n-deliver')!({
    data: { outboxId },
    attemptsMade: 0,
    opts: { attempts: 6 },
  });
}

function runReconcile(): Promise<unknown> {
  return processors.get('n8n-outbox-reconcile')!({ data: {} });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  resetQueueRecords();

  h.env.N8N_WEBHOOK_BASE_URL = '';
  h.env.N8N_HMAC_SECRET = '';
  h.deliveryMode = 'production';
  h.prismaOwner.$transaction.mockImplementation(async (fn) => fn(h.tx));
  h.tx.$queryRaw.mockResolvedValue([]);
  h.tx.n8nDelivery.updateMany.mockResolvedValue({ count: 1 });
  h.isAllowedN8nEvent.mockReturnValue(true);
  h.signOutboundN8n.mockReturnValue({
    signature: 'sha256=sig',
    timestamp: '1784030400000',
    nonce: 'nonce-1',
  });
  h.looksEncrypted.mockImplementation((value) => String(value).startsWith('enc:'));
  h.decryptSecret.mockReturnValue('connection-secret');
  h.tx.n8nConnection.findUnique.mockResolvedValue({
    id: CONNECTION_ID,
    enabled: true,
    routingMode: 'EXPLICIT',
    webhookBaseUrl: null,
    signingSecretEncrypted: 'enc:v2:connection-secret',
  });
  h.tx.tenantSetting.findUnique.mockResolvedValue({
    value: {
      webhookBaseUrl: 'https://n8n.example.com/webhook',
      hmacSecret: 'tenant-secret',
    },
  });
  h.tx.n8nDelivery.findUnique.mockResolvedValue({ ...DELIVERY });
  h.tx.n8nDelivery.findFirst.mockResolvedValue(null);
  h.tx.n8nDelivery.create.mockResolvedValue({ id: 'delivery-legacy' });
  h.tx.n8nOutbox.update.mockResolvedValue({});
  h.tx.n8nOutbox.findMany.mockResolvedValue([]);
  h.tx.n8nDelivery.findMany.mockImplementation(async (args) => {
    if (args?.where?.outboxId) {
      return [{ status: 'DELIVERED', lastError: null, deliveredAt: NOW }];
    }
    return [];
  });
  h.responseCancel.mockResolvedValue(undefined);
  h.safeFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => '',
    body: { cancel: h.responseCancel },
  });
});

afterEach(() => vi.useRealTimers());

describe('n8n delivery worker', () => {
  it('claimt atomar, sendet den stabilen v1-Envelope und aggregiert unter Parent-Lock', async () => {
    await runDelivery();

    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'delivery-1',
        OR: [
          { status: 'PENDING' },
          {
            status: 'PROCESSING',
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: NOW } }],
          },
        ],
      },
      data: {
        status: 'PROCESSING',
        leaseToken: LEASE_TOKEN,
        leaseExpiresAt: new Date(NOW.getTime() + 2 * 60_000),
      },
    });
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    const [url, init, policy] = h.safeFetch.mock.calls[0] as [
      string,
      RequestInit,
      { mode: string; kind: string },
    ];
    expect(url).toBe(DELIVERY.targetUrl);
    expect(policy).toEqual({ mode: 'n8n', kind: 'webhook' });
    expect(init.headers).toMatchObject({
      'x-taxtronik-delivery-id': 'delivery-1',
      'x-taxtronik-event': 'request.opened',
      'x-taxtronik-signature': 'sha256=sig',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: 1,
      eventId: 'outbox-1',
      deliveryId: 'delivery-1',
      event: 'request.opened',
      tenantId: 'tenant-1',
      occurredAt: '2026-07-14T11:55:00.000Z',
      payload: { requestId: 'request-1' },
    });
    expect(h.signOutboundN8n).toHaveBeenCalledWith(
      'request.opened',
      init.body,
      'connection-secret',
    );
    expect(h.responseCancel).toHaveBeenCalledTimes(1);
    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({
        status: 'DELIVERED',
        leaseToken: null,
        leaseExpiresAt: null,
        httpStatus: 200,
      }),
    });
    expect(h.prismaOwner.$transaction).toHaveBeenCalled();
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: expect.objectContaining({ status: 'DELIVERED', lastError: null }),
    });
  });

  it('verhindert zwei parallele Posts derselben Delivery durch den atomaren Claim', async () => {
    let claims = 0;
    h.tx.n8nDelivery.updateMany.mockImplementation(async (args) => {
      if (args?.data?.status === 'PROCESSING' && args?.data?.leaseToken) {
        claims += 1;
        return { count: claims === 1 ? 1 : 0 };
      }
      return { count: 1 };
    });

    await Promise.all([runDelivery(), runDelivery()]);

    expect(claims).toBe(2);
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    expect(h.tx.n8nDelivery.findUnique).toHaveBeenCalledTimes(1);
  });

  it('aggregiert unabhängige Fan-out-Ergebnisse als PARTIAL', async () => {
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      { status: 'DELIVERED', lastError: null, deliveredAt: NOW },
      { status: 'FAILED', lastError: 'HTTP 404', deliveredAt: null },
    ]);

    await runDelivery();

    expect(h.tx.n8nOutbox.update).toHaveBeenLastCalledWith({
      where: { id: 'outbox-1' },
      data: { status: 'PARTIAL', deliveredAt: null, lastError: 'HTTP 404' },
    });
  });

  it.each([401, 403, 404])('behandelt HTTP %s terminal ohne BullMQ-Retry', async (status) => {
    h.safeFetch.mockResolvedValue({ ok: false, status, text: async () => 'denied' });
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      { status: 'FAILED', lastError: `HTTP ${status}: denied`, deliveredAt: null },
    ]);

    await expect(runDelivery()).resolves.toBeUndefined();
    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({ status: 'FAILED', httpStatus: status }),
    });
  });

  it.each([429, 500, 503])(
    'gibt HTTP %s für BullMQ-Retry frei und löst den Lease',
    async (status) => {
      h.safeFetch.mockResolvedValue({ ok: false, status, text: async () => 'later' });

      await expect(runDelivery()).rejects.toThrow(`HTTP ${status}`);
      expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
        where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
        data: {
          status: 'PENDING',
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: `HTTP ${status}: later`,
        },
      });
    },
  );

  it('markiert einen SSRF-Verstoß terminal als FAILED', async () => {
    h.safeFetch.mockRejectedValue(new h.SsrfGuardError('private-ip', 'resolves to 10.0.0.1'));
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      {
        status: 'FAILED',
        lastError: 'SSRF-Guard (private-ip): resolves to 10.0.0.1',
        deliveredAt: null,
      },
    ]);

    await runDelivery();

    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({
        status: 'FAILED',
        lastError: 'SSRF-Guard (private-ip): resolves to 10.0.0.1',
      }),
    });
  });

  it('verwendet bei normalisierter Connection ohne Secret weder Tenant-Legacy noch ENV', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue({
      id: CONNECTION_ID,
      enabled: true,
      routingMode: 'EXPLICIT',
      webhookBaseUrl: null,
      signingSecretEncrypted: null,
    });
    h.env.N8N_HMAC_SECRET = 'global-secret';
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      { status: 'SKIPPED', lastError: 'n8n-Signatur-Secret fehlt', deliveredAt: null },
    ]);

    await runDelivery();

    expect(h.tx.tenantSetting.findUnique).not.toHaveBeenCalled();
    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({
        status: 'SKIPPED',
        lastError: 'n8n-Signatur-Secret fehlt',
      }),
    });
  });

  it('verwendet nach Connection-Löschung oder -Ersetzung kein neues/Legacy-Secret', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue(null);
    h.env.N8N_HMAC_SECRET = 'global-secret';
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      {
        status: 'SKIPPED',
        lastError: 'n8n-Connection der geplanten Route wurde entfernt oder ersetzt',
        deliveredAt: null,
      },
    ]);

    await runDelivery();

    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({
        status: 'SKIPPED',
        lastError: 'n8n-Connection der geplanten Route wurde entfernt oder ersetzt',
      }),
    });
  });

  it('verwendet für eine alte Legacy-Delivery nach Anlegen einer Connection nicht deren Secret', async () => {
    h.tx.n8nDelivery.findUnique.mockResolvedValue({
      ...DELIVERY,
      endpointId: null,
      connectionIdSnapshot: null,
      targetUrl: 'https://n8n.example.com/webhook/request.opened',
      endpoint: null,
    });
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      {
        status: 'SKIPPED',
        lastError: 'n8n-Connection der geplanten Route wurde entfernt oder ersetzt',
        deliveredAt: null,
      },
    ]);

    await runDelivery();

    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({
        status: 'SKIPPED',
        lastError: 'n8n-Connection der geplanten Route wurde entfernt oder ersetzt',
      }),
    });
  });

  it('sendet nach Löschung einer expliziten Route nicht an deren alten URL-Snapshot', async () => {
    h.tx.n8nDelivery.findUnique.mockResolvedValue({
      ...DELIVERY,
      endpointId: null,
      endpoint: null,
    });
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      {
        status: 'SKIPPED',
        lastError: 'n8n-Route, Ziel-URL oder Event-Zuordnung wurde geändert',
        deliveredAt: null,
      },
    ]);

    await runDelivery();

    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({
        status: 'SKIPPED',
        lastError: 'n8n-Route, Ziel-URL oder Event-Zuordnung wurde geändert',
      }),
    });
  });

  it('sendet nach Änderung einer expliziten Ziel-URL nicht an den alten Snapshot', async () => {
    h.tx.n8nDelivery.findUnique.mockResolvedValue({
      ...DELIVERY,
      endpoint: {
        ...DELIVERY.endpoint,
        productionUrl: 'https://n8n.example.com/webhook/new-target',
      },
    });
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      {
        status: 'SKIPPED',
        lastError: 'n8n-Route, Ziel-URL oder Event-Zuordnung wurde geändert',
        deliveredAt: null,
      },
    ]);

    await runDelivery();

    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: expect.objectContaining({ status: 'SKIPPED' }),
    });
  });

  it('protokolliert im Log-Modus nur IDs, Event und Ziel, keine Nutzdaten oder Signaturwerte', async () => {
    h.deliveryMode = 'log';

    await runDelivery();

    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenCalledWith(
      {
        deliveryId: 'delivery-1',
        outboxId: 'outbox-1',
        event: 'request.opened',
        targetUrl: DELIVERY.targetUrl,
      },
      'n8n-deliver: DRY-RUN (N8N_DELIVERY_MODE=log)',
    );
  });

  it('akzeptiert einen alten outboxId-Job und materialisiert genau eine Legacy-Delivery', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue(null);
    h.tx.n8nOutbox.findUnique.mockResolvedValue({
      id: 'outbox-legacy',
      tenantId: 'tenant-1',
      event: 'request.opened',
      status: 'PENDING',
    });
    h.tx.n8nDelivery.findUnique.mockResolvedValue({
      ...DELIVERY,
      id: 'delivery-legacy',
      outboxId: 'outbox-legacy',
      endpointId: null,
      connectionIdSnapshot: null,
      targetUrl: 'https://n8n.example.com/webhook/request.opened',
      endpoint: null,
      outbox: { ...DELIVERY.outbox, id: 'outbox-legacy' },
    });

    await runLegacy();

    expect(h.tx.n8nDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        outboxId: 'outbox-legacy',
        connectionIdSnapshot: null,
        targetUrl: 'https://n8n.example.com/webhook/request.opened',
      }),
      select: { id: true },
    });
    // Ein alter Producer-Job und ein zeitgebundener Recovery-Job können
    // gleichzeitig laufen. Der erste Parent-Lock serialisiert die nullable
    // Legacy-Materialisierung, der zweite gehört zur Terminal-Aggregation.
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('markiert einen Legacy-Altjob ohne Konfiguration als SKIPPED statt DELIVERED', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue(null);
    h.tx.n8nOutbox.findUnique.mockResolvedValue({
      id: 'outbox-legacy',
      tenantId: 'tenant-1',
      event: 'request.opened',
      status: 'PENDING',
    });
    h.tx.tenantSetting.findUnique.mockResolvedValue(null);

    await runLegacy();

    expect(h.safeFetch).not.toHaveBeenCalled();
    expect(h.tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-legacy' },
      data: expect.objectContaining({ status: 'SKIPPED', deliveredAt: null }),
    });
  });

  it('erzeugt für wiederholte Altjobs nach terminaler Delivery keine Dublette', async () => {
    h.tx.n8nDelivery.findFirst.mockResolvedValue({
      id: 'delivery-legacy',
      endpointId: null,
      status: 'FAILED',
    });

    await runLegacy();

    expect(h.tx.n8nDelivery.create).not.toHaveBeenCalled();
    expect(h.tx.n8nOutbox.findUnique).not.toHaveBeenCalled();
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it('stempelt einen transienten Fehler im letzten Versuch atomar FAILED', async () => {
    h.safeFetch.mockResolvedValue({ ok: false, status: 503, text: async () => 'later' });
    h.tx.n8nDelivery.findFirst.mockResolvedValue({ outboxId: 'outbox-1' });
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      { status: 'FAILED', lastError: 'HTTP 503: later', deliveredAt: null },
    ]);

    await expect(runDelivery('delivery-1', 5, 6)).rejects.toThrow('HTTP 503');

    expect(h.tx.n8nDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: 'delivery-1', status: 'PROCESSING', leaseToken: LEASE_TOKEN },
      data: {
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: 'HTTP 503: later',
        deliveredAt: null,
      },
    });
    expect(h.tx.$queryRaw).toHaveBeenCalled();
  });
});

describe('n8n delivery reconciliation', () => {
  it('reiht alte PENDING- und abgelaufene PROCESSING-Deliveries neu ein', async () => {
    h.tx.n8nDelivery.findMany.mockResolvedValue([
      { id: 'd-pending', status: 'PENDING' },
      { id: 'd-processing', status: 'PROCESSING' },
    ]);

    await runReconcile();

    expect(h.tx.n8nDelivery.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: 'PENDING', createdAt: { lt: new Date(NOW.getTime() - 5 * 60_000) } },
          {
            status: 'PROCESSING',
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: NOW } }],
          },
        ],
      },
      select: { id: true, status: true },
      take: 500,
    });
    expect(queueAdds.map((queue) => queue.data)).toEqual([
      { deliveryId: 'd-pending' },
      { deliveryId: 'd-processing' },
    ]);
    const bucket = Math.floor(NOW.getTime() / (5 * 60_000));
    expect(queueAdds.map((queue) => queue.opts.jobId)).toEqual([
      'delivery-d-pending',
      `recovery-delivery-d-processing-${bucket}`,
    ]);
    expect(queueCloses).toEqual(['n8n-deliver']);
  });

  it('behält für alte PENDING-Deliveries die ursprüngliche Job-ID über Reconcile-Fenster', async () => {
    h.tx.n8nDelivery.findMany.mockResolvedValue([{ id: 'd-delayed', status: 'PENDING' }]);

    await runReconcile();
    expect(queueAdds[0]?.opts.jobId).toBe('delivery-d-delayed');
    expect(queueAdds[0]?.opts.jobId).not.toMatch(/^recovery-/);

    // Ein bereits vorhandener delayed Job wird so von BullMQ dedupliziert;
    // auch das nächste Reconcile-Fenster startet keine neue Retry-Kette.
    resetQueueRecords();
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    await runReconcile();
    expect(queueAdds[0]?.opts.jobId).toBe('delivery-d-delayed');
  });

  it('findet alte PENDING-Outboxes ohne Delivery und reiht einen Legacy-Job ein', async () => {
    h.tx.n8nDelivery.findMany.mockResolvedValue([]);
    h.tx.n8nOutbox.findMany.mockResolvedValue([{ id: 'outbox-before-upgrade' }]);

    await runReconcile();

    expect(h.tx.n8nOutbox.findMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(NOW.getTime() - 5 * 60_000) },
        deliveries: { none: {} },
      },
      select: { id: true },
      take: 500,
    });
    expect(queueAdds).toEqual([
      expect.objectContaining({
        queue: 'n8n-deliver',
        jobName: 'deliver',
        data: { outboxId: 'outbox-before-upgrade' },
        opts: expect.objectContaining({
          jobId: 'outbox-outbox-before-upgrade',
        }),
      }),
    ]);
    expect(queueCloses).toEqual(['n8n-deliver']);
  });

  it('umgeht nach Claim-Crash den completed Tombstone des ursprünglichen Jobs', async () => {
    // BullMQ kann einen stalled Job vor Ablauf des DB-Lease erneut ausführen.
    // Der Claim ist dann korrekt ein No-op, BullMQ markiert delivery-d-stuck
    // aber als completed. Reconcile muss danach einen anderen Key verwenden.
    h.tx.n8nDelivery.updateMany.mockResolvedValueOnce({ count: 0 });
    await runDelivery('d-stuck');
    expect(h.safeFetch).not.toHaveBeenCalled();

    h.tx.n8nDelivery.findMany.mockResolvedValue([{ id: 'd-stuck', status: 'PROCESSING' }]);
    await runReconcile();

    const firstRecoveryId = queueAdds[0]?.opts.jobId;
    expect(firstRecoveryId).toBe(
      `recovery-delivery-d-stuck-${Math.floor(NOW.getTime() / (5 * 60_000))}`,
    );
    expect(firstRecoveryId).not.toBe('delivery-d-stuck');

    // Innerhalb eines Fensters bleibt der Key deterministisch; im nächsten
    // Fenster kann auch ein alter failed Recovery-Tombstone nicht blockieren.
    resetQueueRecords();
    await runReconcile();
    expect(queueAdds[0]?.opts.jobId).toBe(firstRecoveryId);

    resetQueueRecords();
    const nextWindow = new Date(NOW.getTime() + 5 * 60_000);
    vi.setSystemTime(nextWindow);
    await runReconcile();
    expect(queueAdds[0]?.opts.jobId).toBe(
      `recovery-delivery-d-stuck-${Math.floor(nextWindow.getTime() / (5 * 60_000))}`,
    );
    expect(queueAdds[0]?.opts.jobId).not.toBe(firstRecoveryId);
  });
});
