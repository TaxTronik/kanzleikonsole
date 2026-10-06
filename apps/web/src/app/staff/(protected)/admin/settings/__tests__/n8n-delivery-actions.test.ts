// =============================================================================
// Regression (R-01): Retry und Replay der n8n-Einstellungen wählen das Ziel
// über dieselbe API wie Outbox-Planung und Worker (`plannedN8nTarget`).
// Vorher ignorierten beide Actions `endpoint.testMode`: Ein Retry an eine
// Test-Route wurde als „Ziel geändert" abgelehnt, ein Replay legte Deliveries
// mit Produktions-URL an, die der Worker anschließend verwarf.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const tx = {
    $queryRaw: vi.fn(),
    n8nConnection: { findUnique: vi.fn() },
    tenantSetting: { findUnique: vi.fn() },
    n8nEventSubscription: { findMany: vi.fn() },
    n8nOutbox: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    n8nDelivery: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    tx,
    queueAdd: vi.fn(),
    evidenceRecord: vi.fn(),
    staffActionGuard: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Produktionsmodus: nur der Debug-Schalter testMode der Route wählt die Test-URL.
vi.mock('@taxtronik/config', () => ({
  env: { N8N_HMAC_SECRET: '', N8N_WEBHOOK_BASE_URL: '', SMTP_FROM: '' },
  n8nDeliveryMode: 'production',
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (_ctx: unknown, fn: (tx: typeof h.tx) => unknown) => fn(h.tx),
}));
vi.mock('@taxtronik/db/tenant-settings', () => ({ deleteTenantSettingValue: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: h.staffActionGuard }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/http/ssrf-guard', () => ({ assertN8nUrl: vi.fn(), safeFetchN8n: vi.fn() }));
vi.mock('@/server/n8n/bundled-workflows', () => ({
  BUNDLED_N8N_WORKFLOWS: [],
  bindN8nHeaderCredential: vi.fn(),
  DEFAULT_GWG_OFFICER_EMAIL: '',
  materializeBundledN8nWorkflow: vi.fn(),
  unresolvedBundledN8nPlaceholders: vi.fn(),
}));
vi.mock('@/server/n8n/client', () => ({ N8nApiClient: vi.fn() }));
vi.mock('@/server/n8n/callback-import-setup', () => ({ prepareN8nCallbackImport: vi.fn() }));
vi.mock('@/server/n8n/queue', () => ({ getN8nDeliverQueue: () => ({ add: h.queueAdd }) }));
vi.mock('@/server/settings/n8n', () => ({
  defaultN8nCallbackBase: vi.fn(),
  N8N_CALLBACK_SCOPES: [],
  readN8nConfig: vi.fn(),
  resolveN8nConfig: vi.fn(),
  writeN8nConfigTx: vi.fn(),
}));
vi.mock('@/server/settings/smtp', () => ({ readSmtpConfig: vi.fn() }));
vi.mock('@/server/n8n/callback-credentials', () => ({ rotateN8nCallbackCredential: vi.fn() }));
vi.mock('@/server/n8n/status', () => ({ toN8nRecentDeliveryView: vi.fn() }));
vi.mock('@/server/n8n/route-activation', () => ({ connectionPatchForSavedRoute: vi.fn() }));

import { replayUnroutedN8nEventAction, retryN8nDeliveryAction } from '../n8n-actions';

const TENANT = '00000000-0000-4000-8000-000000000001';
const DELIVERY_ID = '00000000-0000-4000-8000-000000000020';
const OUTBOX_ID = '00000000-0000-4000-8000-000000000030';
const CONNECTION = {
  id: 'connection-1',
  name: 'Kanzlei n8n',
  enabled: true,
  routingMode: 'EXPLICIT',
  webhookBaseUrl: null,
  signingSecretEncrypted: 'v3:blob',
};
const ROUTE = {
  id: 'endpoint-1',
  name: 'Debug-Route',
  enabled: true,
  connectionId: CONNECTION.id,
  productionUrl: 'https://n8n.example.com/webhook/request-opened',
  testUrl: 'https://n8n.example.com/webhook-test/request-opened',
  testMode: true,
  subscriptions: [{ event: 'request.opened' }],
};

beforeEach(() => {
  vi.resetAllMocks();
  h.staffActionGuard.mockResolvedValue({ ok: true, tenantId: TENANT, staffId: 'staff-1' });
  h.tx.n8nConnection.findUnique.mockResolvedValue({ ...CONNECTION });
  h.tx.$queryRaw.mockResolvedValue([]);
  h.tx.n8nDelivery.findMany.mockResolvedValue([
    { status: 'PENDING', lastError: null, deliveredAt: null },
  ]);
  h.tx.n8nDelivery.create.mockImplementation(async ({ data }) => ({
    id: `delivery-${data.endpointId}`,
  }));
  h.tx.n8nOutbox.updateMany.mockResolvedValue({ count: 1 });
  h.queueAdd.mockResolvedValue({});
});

describe('retryN8nDeliveryAction', () => {
  function failedDelivery(patch: Record<string, unknown> = {}) {
    return {
      id: DELIVERY_ID,
      outboxId: OUTBOX_ID,
      targetUrl: ROUTE.testUrl,
      connectionIdSnapshot: CONNECTION.id,
      outbox: { event: 'request.opened' },
      endpoint: { ...ROUTE },
      ...patch,
    };
  }

  it('plant eine an die Test-URL einer testMode-Route gescheiterte Zustellung erneut ein', async () => {
    h.tx.n8nDelivery.findFirst.mockResolvedValue(failedDelivery());

    const result = await retryN8nDeliveryAction(DELIVERY_ID);

    expect(result).toEqual({ ok: true, message: 'Zustellung wurde erneut eingeplant.' });
    expect(h.tx.n8nDelivery.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          endpoint: { select: expect.objectContaining({ testMode: true }) },
        }),
      }),
    );
    expect(h.tx.n8nDelivery.update).toHaveBeenCalledWith({
      where: { id: DELIVERY_ID },
      data: expect.objectContaining({ status: 'PENDING', lastError: null }),
    });
    const [name, data, opts] = h.queueAdd.mock.calls[0]!;
    expect(name).toBe('deliver');
    expect(data).toEqual({ deliveryId: DELIVERY_ID });
    expect(opts).toMatchObject({
      attempts: 6,
      backoff: { type: 'exponential', delay: 60_000 },
      jobId: expect.stringMatching(new RegExp(`^manual-retry-${DELIVERY_ID}-`)),
    });
  });

  it.each([
    [
      'einen Produktions-Snapshot, nachdem die Route in den testMode wechselte',
      {
        targetUrl: ROUTE.productionUrl,
      },
    ],
    ['eine Legacy-Zustellung ohne Route', { endpoint: null }],
    ['eine Zustellung einer ersetzten Connection', { connectionIdSnapshot: 'connection-0' }],
  ])('lehnt %s ab', async (_label, patch) => {
    h.tx.n8nDelivery.findFirst.mockResolvedValue(failedDelivery(patch));

    const result = await retryN8nDeliveryAction(DELIVERY_ID);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Das ursprüngliche Ziel wurde geändert');
    expect(h.tx.n8nDelivery.update).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled();
  });

  it('lehnt ohne gespeichertes Signatur-Secret ab', async () => {
    h.tx.n8nDelivery.findFirst.mockResolvedValue(failedDelivery());
    h.tx.n8nConnection.findUnique.mockResolvedValue({
      ...CONNECTION,
      signingSecretEncrypted: null,
    });

    const result = await retryN8nDeliveryAction(DELIVERY_ID);

    expect(result.ok).toBe(false);
    expect(h.queueAdd).not.toHaveBeenCalled();
  });
});

describe('replayUnroutedN8nEventAction', () => {
  beforeEach(() => {
    h.tx.n8nOutbox.findFirst.mockResolvedValue({ id: OUTBOX_ID, event: 'request.opened' });
    h.tx.n8nEventSubscription.findMany.mockResolvedValue([
      {
        endpoint: {
          id: ROUTE.id,
          name: ROUTE.name,
          productionUrl: ROUTE.productionUrl,
          testUrl: ROUTE.testUrl,
          testMode: true,
        },
      },
    ]);
  });

  it('legt für eine Route im testMode eine Delivery mit deren Test-URL an', async () => {
    const result = await replayUnroutedN8nEventAction(OUTBOX_ID);

    expect(result).toEqual({ ok: true, message: '1 Ziel(e) zugeordnet.' });
    expect(h.tx.n8nEventSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          endpoint: {
            select: { id: true, name: true, productionUrl: true, testUrl: true, testMode: true },
          },
        },
      }),
    );
    expect(h.tx.n8nDelivery.create).toHaveBeenCalledWith({
      data: {
        tenantId: TENANT,
        outboxId: OUTBOX_ID,
        endpointId: ROUTE.id,
        connectionIdSnapshot: CONNECTION.id,
        endpointNameSnapshot: ROUTE.name,
        targetUrl: ROUTE.testUrl,
        status: 'PENDING',
        lastError: null,
      },
      select: { id: true },
    });
    expect(h.queueAdd).toHaveBeenCalledWith(
      'deliver',
      { deliveryId: `delivery-${ROUTE.id}` },
      expect.objectContaining({ jobId: `delivery-delivery-${ROUTE.id}`, attempts: 6 }),
    );
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        action: 'tenant.settings.n8n.event.replay',
        after: { event: 'request.opened', deliveriesCreated: 1, skipped: 0 },
      }),
    );
  });

  it('verlangt aktives explizites Routing mit Signatur-Secret', async () => {
    h.tx.n8nConnection.findUnique.mockResolvedValue({
      ...CONNECTION,
      signingSecretEncrypted: null,
    });

    const result = await replayUnroutedN8nEventAction(OUTBOX_ID);

    expect(result).toEqual({
      ok: false,
      error: 'Explizites Routing muss aktiv sein und ein Signatur-Secret enthalten.',
    });
    expect(h.tx.n8nOutbox.updateMany).not.toHaveBeenCalled();
    expect(h.tx.n8nDelivery.create).not.toHaveBeenCalled();
  });
});
