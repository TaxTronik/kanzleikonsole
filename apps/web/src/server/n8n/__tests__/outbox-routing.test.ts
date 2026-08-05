import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const tx = {
    tenantSetting: { findUnique: vi.fn() },
    n8nConnection: { findUnique: vi.fn() },
    n8nEventSubscription: { findMany: vi.fn(), count: vi.fn() },
    n8nOutbox: { create: vi.fn(), update: vi.fn() },
    n8nDelivery: { create: vi.fn() },
  };
  return {
    tx,
    env: { N8N_WEBHOOK_BASE_URL: '', N8N_HMAC_SECRET: '' },
    queueAdd: vi.fn(),
    isAllowedN8nEvent: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    prismaOwner: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
  };
});

vi.mock('@taxtronik/config', () => ({ env: h.env, n8nDeliveryMode: 'production' }));
vi.mock('@taxtronik/n8n-shared', () => ({ isAllowedN8nEvent: h.isAllowedN8nEvent }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: h.prismaOwner }));
vi.mock('@/server/logger', () => ({ log: h.log }));
vi.mock('../queue', () => ({ getN8nDeliverQueue: () => ({ add: h.queueAdd }) }));

import { enqueueN8nEvent } from '../outbox';

const CONNECTION = {
  id: 'connection-1',
  name: 'Kanzlei n8n',
  enabled: true,
  routingMode: 'EXPLICIT',
  webhookBaseUrl: null,
  signingSecretEncrypted: 'enc:v2:secret',
};

beforeEach(() => {
  vi.resetAllMocks();
  h.env.N8N_WEBHOOK_BASE_URL = '';
  h.env.N8N_HMAC_SECRET = '';
  h.isAllowedN8nEvent.mockReturnValue(true);
  h.tx.n8nOutbox.create.mockResolvedValue({ id: 'outbox-1' });
  h.tx.n8nOutbox.update.mockResolvedValue({});
  h.tx.tenantSetting.findUnique.mockResolvedValue(null);
  h.tx.n8nConnection.findUnique.mockResolvedValue({ ...CONNECTION });
  h.tx.n8nEventSubscription.findMany.mockResolvedValue([]);
  h.tx.n8nEventSubscription.count.mockResolvedValue(0);
  h.tx.n8nDelivery.create.mockImplementation(async ({ data }) => ({
    id: data.endpointId ? `delivery-${data.endpointId}` : 'delivery-synthetic',
  }));
  h.queueAdd.mockResolvedValue({});
});

describe('enqueueN8nEvent routing', () => {
  it('erzeugt im EXPLICIT-Modus pro Subscription eine Delivery und einen Job', async () => {
    h.tx.n8nEventSubscription.findMany.mockResolvedValue([
      {
        endpoint: {
          id: 'endpoint-a',
          name: 'Mandantenmail',
          productionUrl: 'https://n8n.example/webhook/a',
          testUrl: 'https://n8n.example/webhook-test/a',
        },
      },
      {
        endpoint: {
          id: 'endpoint-b',
          name: 'CRM',
          productionUrl: 'https://n8n.example/webhook/b',
          testUrl: 'https://n8n.example/webhook-test/b',
        },
      },
    ]);

    const result = await enqueueN8nEvent(
      'request.opened',
      { requestId: 'request-1' },
      { tenantId: 'tenant-1' },
    );

    expect(h.tx.n8nEventSubscription.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        event: 'request.opened',
        enabled: true,
        endpoint: { connectionId: 'connection-1', enabled: true },
      },
      select: {
        endpoint: {
          select: { id: true, name: true, productionUrl: true, testUrl: true, testMode: true },
        },
      },
    });
    expect(h.tx.n8nDelivery.create).toHaveBeenCalledTimes(2);
    expect(h.tx.n8nDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ connectionIdSnapshot: 'connection-1' }),
      select: { id: true },
    });
    expect(h.queueAdd.mock.calls.map((call) => call[1])).toEqual([
      { deliveryId: 'delivery-endpoint-a' },
      { deliveryId: 'delivery-endpoint-b' },
    ]);
    expect(h.queueAdd.mock.calls.map((call) => call[2].jobId)).toEqual([
      'delivery-delivery-endpoint-a',
      'delivery-delivery-endpoint-b',
    ]);
    expect(result).toEqual({ eventId: 'outbox-1', status: 'PENDING', deliveryCount: 2 });
  });

  it('markiert ein konfiguriertes EXPLICIT-Event ohne aktive Route als UNROUTED', async () => {
    h.tx.n8nEventSubscription.count.mockResolvedValue(1);
    const result = await enqueueN8nEvent(
      'request.opened',
      { requestId: 'request-1' },
      { tenantId: 'tenant-1' },
    );

    expect(h.tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: {
        status: 'UNROUTED',
        lastError: "Konfigurierte n8n-Route für Event 'request.opened' ist nicht aktiv",
      },
    });
    expect(h.queueAdd).not.toHaveBeenCalled();
    expect(result).toEqual({
      eventId: 'outbox-1',
      status: 'UNROUTED',
      deliveryCount: 0,
      error: "Konfigurierte n8n-Route für Event 'request.opened' ist nicht aktiv",
    });
  });

  it('überspringt ein im EXPLICIT-Modus nie abonniertes Event ohne Betriebsalarm', async () => {
    const result = await enqueueN8nEvent(
      'request.closed',
      { requestId: 'request-1' },
      { tenantId: 'tenant-1' },
    );

    expect(h.tx.n8nEventSubscription.count).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        event: 'request.closed',
        endpoint: { connectionId: 'connection-1' },
      },
    });
    expect(h.tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: {
        status: 'SKIPPED',
        lastError: "Event 'request.closed' ist für n8n nicht abonniert",
      },
    });
    expect(h.queueAdd).not.toHaveBeenCalled();
    expect(result).toEqual({
      eventId: 'outbox-1',
      status: 'SKIPPED',
      deliveryCount: 0,
      error: "Event 'request.closed' ist für n8n nicht abonniert",
    });
  });

  it('markiert eine bewusst deaktivierte Integration als SKIPPED', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue({
      ...CONNECTION,
      routingMode: 'DISABLED',
    });

    const result = await enqueueN8nEvent(
      'request.opened',
      { requestId: 'request-1' },
      { tenantId: 'tenant-1' },
    );

    expect(h.tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: { status: 'SKIPPED', lastError: 'n8n-Integration bewusst deaktiviert' },
    });
    expect(h.queueAdd).not.toHaveBeenCalled();
    expect(result).toEqual({
      eventId: 'outbox-1',
      status: 'SKIPPED',
      deliveryCount: 1,
      error: 'n8n-Integration bewusst deaktiviert',
    });
  });

  it('fällt bei normalisierter Connection ohne Secret nicht auf Legacy oder ENV zurück', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue({
      ...CONNECTION,
      signingSecretEncrypted: null,
    });
    h.tx.tenantSetting.findUnique.mockResolvedValue({
      value: { hmacSecret: 'altes-tenant-secret' },
    });
    h.env.N8N_HMAC_SECRET = 'globales-secret';
    h.tx.n8nEventSubscription.findMany.mockResolvedValue([
      {
        endpoint: {
          id: 'endpoint-a',
          name: 'Recherche',
          productionUrl: 'https://n8n.example/webhook/research',
          testUrl: null,
        },
      },
    ]);

    const result = await enqueueN8nEvent(
      'risk.research_requested',
      { researchRequestId: 'request-1' },
      { tenantId: 'tenant-1' },
    );

    expect(result).toEqual({
      eventId: 'outbox-1',
      status: 'SKIPPED',
      deliveryCount: 1,
      error: 'Alle n8n-Zustellungen wurden übersprungen',
    });
    expect(h.tx.n8nDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        connectionIdSnapshot: 'connection-1',
        status: 'SKIPPED',
        lastError: 'n8n-Signatur-Secret fehlt',
      }),
      select: { id: true },
    });
    expect(h.tx.tenantSetting.findUnique).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it('verwendet ohne normalisierte Connection die persistierte Legacy-Base-URL', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue(null);
    h.tx.tenantSetting.findUnique.mockResolvedValue({
      value: {
        webhookBaseUrl: 'https://n8n.example/hooks',
        hmacSecret: 'legacy-secret',
      },
    });

    await enqueueN8nEvent('request.opened', { requestId: 'request-1' }, { tenantId: 'tenant-1' });

    expect(h.tx.n8nDelivery.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        outboxId: 'outbox-1',
        connectionIdSnapshot: null,
        endpointNameSnapshot: 'Legacy: request.opened',
        targetUrl: 'https://n8n.example/hooks/request.opened',
      },
      select: { id: true },
    });
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
  });

  it('markiert fehlende Legacy-Konfiguration als SKIPPED, niemals DELIVERED', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue(null);

    await enqueueN8nEvent('request.opened', { requestId: 'request-1' }, { tenantId: 'tenant-1' });

    expect(h.tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'outbox-1' },
      data: { status: 'SKIPPED', lastError: 'n8n nicht vollständig konfiguriert' },
    });
    expect(h.tx.n8nOutbox.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DELIVERED' }) }),
    );
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it('liefert für ein ungültiges Event einen expliziten Fehlerstatus', async () => {
    h.isAllowedN8nEvent.mockReturnValue(false);

    const result = await enqueueN8nEvent(
      'workflow.step.invalid suffix',
      {},
      { tenantId: 'tenant-1' },
    );

    expect(result).toEqual({
      eventId: null,
      status: 'INVALID_EVENT',
      deliveryCount: 0,
      error: "Event 'workflow.step.invalid suffix' ist nicht freigegeben",
    });
    expect(h.prismaOwner.$transaction).not.toHaveBeenCalled();
  });

  it('liefert bei einem Outbox-Schreibfehler WRITE_FAILED statt void', async () => {
    h.prismaOwner.$transaction.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await enqueueN8nEvent(
      'request.opened',
      { requestId: 'request-1' },
      { tenantId: 'tenant-1' },
    );

    expect(result).toEqual({
      eventId: null,
      status: 'WRITE_FAILED',
      deliveryCount: 0,
      error: 'n8n-Outbox konnte nicht geschrieben werden',
    });
  });
});
