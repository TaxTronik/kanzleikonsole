// =============================================================================
// Unit-Tests: gemeinsame n8n-Delivery-Bausteine (R-01) — Konfiguration laden,
// Routen planen (inkl. testMode) und Outbox-Status aggregieren.
// =============================================================================

import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@taxtronik/config', () => ({
  env: { N8N_HMAC_SECRET: 'env-secret', N8N_WEBHOOK_BASE_URL: '' },
  n8nDeliveryMode: 'production',
}));

import {
  aggregateN8nOutboxStatus,
  aggregateN8nOutboxTx,
  createPlannedN8nDeliveriesTx,
  findActiveN8nRouteEndpointsTx,
  readN8nDeliveryConfig,
} from '../deliveries';

const tx = {
  $queryRaw: vi.fn(),
  n8nConnection: { findUnique: vi.fn() },
  tenantSetting: { findUnique: vi.fn() },
  n8nEventSubscription: { findMany: vi.fn() },
  n8nDelivery: { create: vi.fn(), findMany: vi.fn() },
  n8nOutbox: { update: vi.fn() },
};
const client = tx as unknown as Prisma.TransactionClient;
const NOW = new Date('2026-07-14T12:00:00.000Z');

beforeEach(() => {
  vi.resetAllMocks();
  tx.n8nDelivery.create.mockImplementation(async ({ data }) => ({ id: `d-${data.endpointId}` }));
});

describe('readN8nDeliveryConfig', () => {
  it('liest bei vorhandener Connection kein Legacy-Setting', async () => {
    tx.n8nConnection.findUnique.mockResolvedValue({
      id: 'c-1',
      name: 'n8n',
      enabled: true,
      routingMode: 'EXPLICIT',
      webhookBaseUrl: null,
      signingSecretEncrypted: 'v3:blob',
    });

    const config = await readN8nDeliveryConfig(client, 'tenant-1');

    expect(tx.n8nConnection.findUnique).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
      select: {
        id: true,
        name: true,
        enabled: true,
        routingMode: true,
        webhookBaseUrl: true,
        signingSecretEncrypted: true,
      },
    });
    expect(tx.tenantSetting.findUnique).not.toHaveBeenCalled();
    expect(config.secretSource.kind).toBe('CONNECTION');
  });

  it('liest ohne Connection den Legacy-Eintrag und unterscheidet ihn von „kein Eintrag"', async () => {
    tx.n8nConnection.findUnique.mockResolvedValue(null);
    tx.tenantSetting.findUnique.mockResolvedValueOnce({ value: { webhookBaseUrl: 'https://x' } });

    const legacy = await readN8nDeliveryConfig(client, 'tenant-1');
    expect(tx.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: 'tenant-1', key: 'integrations.n8n' } },
      select: { value: true },
    });
    expect(legacy.secretSource).toMatchObject({ kind: 'LEGACY_SETTING', plain: null });

    tx.tenantSetting.findUnique.mockResolvedValueOnce(null);
    const fallback = await readN8nDeliveryConfig(client, 'tenant-1');
    expect(fallback.secretSource).toEqual({ kind: 'ENV', plain: 'env-secret' });
  });

  it('greift ohne Tenant auf keine Tabelle zu', async () => {
    const config = await readN8nDeliveryConfig(client, null);
    expect(tx.n8nConnection.findUnique).not.toHaveBeenCalled();
    expect(tx.tenantSetting.findUnique).not.toHaveBeenCalled();
    expect(config.secretSource.kind).toBe('ENV');
  });
});

describe('findActiveN8nRouteEndpointsTx', () => {
  it('liest aktive Routen samt testMode der Connection', async () => {
    const endpoint = {
      id: 'e-1',
      name: 'CRM',
      productionUrl: 'https://n8n/webhook/a',
      testUrl: 'https://n8n/webhook-test/a',
      testMode: true,
    };
    tx.n8nEventSubscription.findMany.mockResolvedValue([{ endpoint }]);

    await expect(
      findActiveN8nRouteEndpointsTx(client, {
        tenantId: 'tenant-1',
        event: 'request.opened',
        connectionId: 'c-1',
      }),
    ).resolves.toEqual([endpoint]);
    expect(tx.n8nEventSubscription.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        event: 'request.opened',
        enabled: true,
        endpoint: { connectionId: 'c-1', enabled: true },
      },
      select: {
        endpoint: {
          select: { id: true, name: true, productionUrl: true, testUrl: true, testMode: true },
        },
      },
    });
  });
});

describe('createPlannedN8nDeliveriesTx', () => {
  const base = {
    tenantId: 'tenant-1',
    outboxId: 'o-1',
    connectionId: 'c-1',
    signingSecretAvailable: true,
  };
  const productionRoute = {
    id: 'e-prod',
    name: 'Produktion',
    productionUrl: 'https://n8n/webhook/prod',
    testUrl: 'https://n8n/webhook-test/prod',
    testMode: false,
  };
  const debugRoute = {
    id: 'e-debug',
    name: 'Debug',
    productionUrl: 'https://n8n/webhook/debug',
    testUrl: 'https://n8n/webhook-test/debug',
    testMode: true,
  };

  it('plant Routen im testMode an ihre Test-URL und alle anderen an die Produktions-URL', async () => {
    const planned = await createPlannedN8nDeliveriesTx(client, {
      ...base,
      endpoints: [productionRoute, debugRoute],
      mode: 'production',
    });

    expect(planned).toEqual({ pendingIds: ['d-e-prod', 'd-e-debug'], skipped: 0 });
    expect(tx.n8nDelivery.create.mock.calls.map(([args]) => args.data)).toEqual([
      {
        tenantId: 'tenant-1',
        outboxId: 'o-1',
        endpointId: 'e-prod',
        connectionIdSnapshot: 'c-1',
        endpointNameSnapshot: 'Produktion',
        targetUrl: 'https://n8n/webhook/prod',
        status: 'PENDING',
        lastError: null,
      },
      {
        tenantId: 'tenant-1',
        outboxId: 'o-1',
        endpointId: 'e-debug',
        connectionIdSnapshot: 'c-1',
        endpointNameSnapshot: 'Debug',
        targetUrl: 'https://n8n/webhook-test/debug',
        status: 'PENDING',
        lastError: null,
      },
    ]);
  });

  it('legt ohne Secret bzw. ohne verlangtes Test-Ziel SKIPPED-Deliveries mit Grund an', async () => {
    const withoutSecret = await createPlannedN8nDeliveriesTx(client, {
      ...base,
      signingSecretAvailable: false,
      endpoints: [productionRoute],
      mode: 'production',
    });
    expect(withoutSecret).toEqual({ pendingIds: [], skipped: 1 });
    expect(tx.n8nDelivery.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ status: 'SKIPPED', lastError: 'n8n-Signatur-Secret fehlt' }),
      select: { id: true },
    });

    const withoutTestUrl = await createPlannedN8nDeliveriesTx(client, {
      ...base,
      endpoints: [{ ...productionRoute, testUrl: null }],
      mode: 'test',
    });
    expect(withoutTestUrl).toEqual({ pendingIds: [], skipped: 1 });
    expect(tx.n8nDelivery.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        targetUrl: null,
        status: 'SKIPPED',
        lastError: 'Kein sicherer n8n-Test-Webhook für diesen Endpoint konfiguriert',
      }),
      select: { id: true },
    });
  });
});

describe('aggregateN8nOutboxStatus', () => {
  const delivered = (deliveredAt: Date) => ({ status: 'DELIVERED', lastError: null, deliveredAt });

  it.each([
    [[{ status: 'PROCESSING', lastError: null, deliveredAt: null }, delivered(NOW)], 'PENDING'],
    [[{ status: 'FAILED', lastError: 'HTTP 404', deliveredAt: null }], 'FAILED'],
    [[{ status: 'SKIPPED', lastError: 'aus', deliveredAt: null }], 'SKIPPED'],
    [[delivered(NOW), { status: 'FAILED', lastError: 'HTTP 404', deliveredAt: null }], 'PARTIAL'],
  ])('aggregiert %j zu %s', (deliveries, status) => {
    expect(aggregateN8nOutboxStatus(deliveries).status).toBe(status);
  });

  it('übernimmt bei vollständiger Zustellung den spätesten Zeitpunkt und keinen Fehler', () => {
    const later = new Date(NOW.getTime() + 1_000);
    expect(aggregateN8nOutboxStatus([delivered(NOW), delivered(later)])).toEqual({
      status: 'DELIVERED',
      deliveredAt: later,
      lastError: null,
    });
  });

  it('meldet einen FAILED-Grund vor einem SKIPPED-Grund', () => {
    expect(
      aggregateN8nOutboxStatus([
        { status: 'SKIPPED', lastError: 'übersprungen', deliveredAt: null },
        { status: 'FAILED', lastError: 'HTTP 500', deliveredAt: null },
      ]),
    ).toEqual({ status: 'PARTIAL', deliveredAt: null, lastError: 'HTTP 500' });
  });
});

describe('aggregateN8nOutboxTx', () => {
  it('sperrt den Outbox-Satz und schreibt den aggregierten Status', async () => {
    tx.n8nDelivery.findMany.mockResolvedValue([
      { status: 'DELIVERED', lastError: null, deliveredAt: NOW },
    ]);

    await aggregateN8nOutboxTx(client, 'o-1');

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.n8nDelivery.findMany).toHaveBeenCalledWith({
      where: { outboxId: 'o-1' },
      select: { status: true, lastError: true, deliveredAt: true },
    });
    expect(tx.n8nOutbox.update).toHaveBeenCalledWith({
      where: { id: 'o-1' },
      data: { status: 'DELIVERED', deliveredAt: NOW, lastError: null },
    });
  });

  it('lässt ein Event ohne Deliveries unverändert', async () => {
    tx.n8nDelivery.findMany.mockResolvedValue([]);
    await aggregateN8nOutboxTx(client, 'o-1');
    expect(tx.n8nOutbox.update).not.toHaveBeenCalled();
  });
});
