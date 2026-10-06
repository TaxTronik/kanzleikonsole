// Fachkatalog: AUDIT-HASH-CHAIN-001
// Review-Finding K-03: die Services der n8n-Einstellungen (server/n8n-settings)
// gegen echtes PostgreSQL — App-Rolle mit RLS, Constraints der n8n-Tabellen
// (eindeutige Routennamen, Kaskaden), Outbox-/Delivery-Zustände samt
// Aggregation und die Audit-Hash-Chain. Ersetzt werden nur ENV, die DNS-basierte
// SSRF-Prüfung, die BullMQ-Queue und die Verbindungsgrenze.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter, type AuditEventInput } from '@taxtronik/evidence';

const fixture = vi.hoisted(() => ({
  inTransaction: false,
  run: async (_ctx: TenantContext, _run: (tx: TxClient) => unknown): Promise<unknown> => undefined,
  record: async (_tx: TxClient, _event: AuditEventInput): Promise<unknown> => undefined,
  queued: [] as unknown[][],
  queueError: null as Error | null,
  revalidated: [] as string[],
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@taxtronik/config', () => ({
  env: {
    NODE_ENV: 'test',
    NEXTAUTH_URL: 'https://app.k03.test',
    N8N_HMAC_SECRET: '',
    N8N_WEBHOOK_BASE_URL: '',
    SMTP_FROM: '',
  },
  n8nDeliveryMode: 'production',
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
vi.mock('@/server/container', () => ({
  evidenceService: {
    record: (tx: TxClient, event: AuditEventInput) => fixture.record(tx, event),
  },
}));
// Die SSRF-Prüfung löst DNS auf; hier zählt nur der Datenbankpfad.
vi.mock('@/server/http/ssrf-guard', () => ({
  assertN8nUrl: async () => undefined,
  safeFetchN8n: vi.fn(),
  urlTargetErrorMessage: () => null,
}));
vi.mock('@/server/n8n/queue', () => ({
  getN8nDeliverQueue: () => ({
    add: async (...args: unknown[]) => {
      if (fixture.queueError) throw fixture.queueError;
      fixture.queued.push(args);
      return {};
    },
  }),
}));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    // Revalidiert wird erst nach dem Commit.
    expect(fixture.inTransaction).toBe(false);
    fixture.revalidated.push(path);
  },
}));

import { resetN8nConnection } from '../connection';
import {
  acknowledgeN8nDelivery,
  listFailedN8nDeliveries,
  replayUnroutedN8nEvent,
  retryN8nDelivery,
  skipUnroutedN8nEvent,
} from '../deliveries';
import { deleteN8nEndpoint, saveN8nEndpoint } from '../endpoints';
import type { N8nEndpointInput } from '../validation';

// Der normale Qualitätsjob hat keine Datenbank; der db-Job schaltet die Suite
// ausdrücklich zu. Dann gelten nur lokale PostgreSQL-Ziele.
const enabled = process.env.N8N_SETTINGS_DB_TEST === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`N8N_SETTINGS_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`N8N_SETTINGS_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const SETTINGS_PAGES = ['/staff/admin/settings/n8n', '/staff/admin/settings/integrations'];

(enabled ? describe : describe.skip)('K-03 n8n-Einstellungs-Services gegen PostgreSQL', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  const evidence = new EvidenceService(new LocalTimestampAdapter());
  let tenantId: string, staffId: string, connectionId: string;
  let ctx: { tenantId: string; actorId: string; actorType: 'STAFF' };

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = (
      await owner.tenant.create({ data: { slug: `k03-n8n-${suffix}`, name: 'K-03 n8n' } })
    ).id;
    staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `k03-n8n-${suffix}@example.test`,
          fullName: 'K-03 Admin',
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    // Gespeicherte Verbindung mit (hier nicht entschlüsseltem) Signatur-Secret,
    // noch ohne freigegebenes Routing.
    connectionId = (
      await owner.n8nConnection.create({
        data: {
          tenantId,
          name: 'K-03 n8n',
          kind: 'SELF_HOSTED',
          routingMode: 'DISABLED',
          enabled: false,
          signingSecretEncrypted: 'v3:k03-synthetic-secret-blob',
        },
      })
    ).id;
    ctx = { tenantId, actorId: staffId, actorType: 'STAFF' };
    fixture.run = async (context, run) => {
      expect(context).toEqual(ctx);
      expect(fixture.inTransaction).toBe(false);
      fixture.inTransaction = true;
      try {
        return await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
          return run(tx);
        });
      } finally {
        fixture.inTransaction = false;
      }
    };
    fixture.record = (tx, event) => evidence.record(tx, event);
  });

  beforeEach(() => {
    fixture.queued = [];
    fixture.queueError = null;
    fixture.revalidated = [];
  });

  afterAll(async () => {
    // Wie die übrigen DB-Suiten: der synthetische Tenant bleibt mit seinen
    // append-only Audit-Zeilen in der Wegwerf-Datenbank; Evidence-Guards bleiben aktiv.
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });

  function route(patch: Partial<N8nEndpointInput> = {}): N8nEndpointInput {
    const path = randomUUID().slice(0, 8);
    return {
      id: '',
      name: `Route ${path}`,
      productionUrl: `https://n8n.example.com/webhook/${path}`,
      testUrl: `https://n8n.example.com/webhook-test/${path}`,
      workflowId: '',
      workflowName: '',
      workflowNodeId: '',
      source: 'CUSTOM',
      enabled: true,
      testMode: false,
      events: ['client.created'],
      ...patch,
    };
  }

  const audits = (resourceId: string) =>
    owner.auditLog.findMany({
      where: { tenantId, resourceId },
      orderBy: { id: 'asc' },
      select: { action: true, after: true },
    });

  async function expectIntactChainTail() {
    const tail = await owner.auditLog.findMany({
      where: { tenantId },
      orderBy: { id: 'desc' },
      take: 20,
      select: { prevHash: true, thisHash: true },
    });
    for (let index = 0; index < tail.length - 1; index++) {
      expect(
        Buffer.from(tail[index]!.prevHash).equals(Buffer.from(tail[index + 1]!.thisHash)),
      ).toBe(true);
    }
  }

  async function savedRoute(patch: Partial<N8nEndpointInput> = {}) {
    const input = route(patch);
    const result = await saveN8nEndpoint(ctx, input);
    expect(result.ok).toBe(true);
    const row = await owner.n8nWebhookEndpoint.findFirstOrThrow({
      where: { tenantId, name: input.name },
    });
    // Die Anlage selbst revalidiert; die Tests prüfen nur ihren eigenen Aufruf.
    fixture.revalidated = [];
    return { input, id: row.id, row };
  }

  async function outbox(event: string, status: 'PENDING' | 'UNROUTED' | 'FAILED') {
    return owner.n8nOutbox.create({
      data: { tenantId, event, payload: { synthetic: true }, status },
      select: { id: true, event: true },
    });
  }

  async function delivery(
    outboxId: string,
    endpoint: { id: string; name: string },
    data: { targetUrl: string; status: 'PENDING' | 'FAILED'; lastError?: string },
  ) {
    return owner.n8nDelivery.create({
      data: {
        tenantId,
        outboxId,
        endpointId: endpoint.id,
        connectionIdSnapshot: connectionId,
        endpointNameSnapshot: endpoint.name,
        ...data,
      },
      select: { id: true },
    });
  }

  it('legt eine aktivierte Route an und gibt die Verbindung für explizite Routen frei', async () => {
    const input = route({ events: ['client.created', 'request.opened', 'client.created'] });

    const result = await saveN8nEndpoint(ctx, input);

    expect(result).toEqual({
      ok: true,
      connectionActivated: true,
      message: 'Workflow-Route gespeichert; n8n ist jetzt für explizite Routen aktiviert.',
    });
    const row = await owner.n8nWebhookEndpoint.findFirstOrThrow({
      where: { tenantId, name: input.name },
      include: { subscriptions: { orderBy: { event: 'asc' } } },
    });
    expect(row).toMatchObject({
      connectionId,
      productionUrl: input.productionUrl,
      testUrl: input.testUrl,
      workflowId: null,
      source: 'CUSTOM',
      enabled: true,
      testMode: false,
    });
    expect(row.subscriptions.map((item) => item.event)).toEqual([
      'client.created',
      'request.opened',
    ]);
    expect(
      await owner.n8nConnection.findUniqueOrThrow({
        where: { id: connectionId },
        select: { enabled: true, routingMode: true },
      }),
    ).toEqual({ enabled: true, routingMode: 'EXPLICIT' });
    expect(await audits(row.id)).toEqual([
      {
        action: 'tenant.settings.n8n.endpoint.upsert',
        after: {
          name: input.name,
          productionUrl: input.productionUrl,
          testUrl: input.testUrl,
          enabledRequested: true,
          enabled: true,
          testMode: false,
          events: input.events,
          connectionActivated: true,
          cancelledPendingDeliveries: 0,
        },
      },
    ]);
    expect(fixture.revalidated).toEqual(SETTINGS_PAGES);
    await expectIntactChainTail();
  });

  it('bricht bei geändertem Ziel wartende Zustellungen ab und setzt die Verifikation zurück', async () => {
    const { input, id } = await savedRoute();
    await owner.n8nWebhookEndpoint.update({
      where: { id },
      data: { verifiedAt: new Date(), verificationOk: true },
    });
    const event = await outbox('client.created', 'PENDING');
    const pending = await delivery(
      event.id,
      { id, name: input.name },
      { targetUrl: input.productionUrl, status: 'PENDING' },
    );

    const result = await saveN8nEndpoint(ctx, {
      ...input,
      id,
      productionUrl: `${input.productionUrl}-neu`,
    });

    expect(result).toEqual({
      ok: true,
      connectionActivated: false,
      message: 'Workflow-Route gespeichert.',
    });
    expect(
      await owner.n8nWebhookEndpoint.findUniqueOrThrow({
        where: { id },
        select: { productionUrl: true, verifiedAt: true, verificationOk: true },
      }),
    ).toEqual({
      productionUrl: `${input.productionUrl}-neu`,
      verifiedAt: null,
      verificationOk: null,
    });
    expect(
      await owner.n8nDelivery.findUniqueOrThrow({
        where: { id: pending.id },
        select: { status: true, lastError: true },
      }),
    ).toEqual({ status: 'SKIPPED', lastError: 'n8n-Route oder Event-Zuordnung wurde geändert' });
    expect((await audits(id)).at(-1)).toEqual({
      action: 'tenant.settings.n8n.endpoint.upsert',
      after: expect.objectContaining({ cancelledPendingDeliveries: 1, connectionActivated: false }),
    });
  });

  it('meldet doppelte Namen und unbekannte Routen ohne Teil-Writes', async () => {
    const { input } = await savedRoute();
    const routes = await owner.n8nWebhookEndpoint.count({ where: { tenantId } });

    await expect(saveN8nEndpoint(ctx, route({ name: input.name }))).resolves.toEqual({
      ok: false,
      error: 'Eine Route mit diesem Namen existiert bereits.',
    });
    await expect(saveN8nEndpoint(ctx, route({ id: randomUUID() }))).resolves.toEqual({
      ok: false,
      error: 'Webhook-Route nicht gefunden.',
    });
    expect(await owner.n8nWebhookEndpoint.count({ where: { tenantId } })).toBe(routes);
    expect(fixture.revalidated).toEqual([]);
  });

  it('entfernt eine Route samt Abos und bricht ihre wartenden Zustellungen ab', async () => {
    const { input, id } = await savedRoute();
    const event = await outbox('client.created', 'PENDING');
    const pending = await delivery(
      event.id,
      { id, name: input.name },
      { targetUrl: input.productionUrl, status: 'PENDING' },
    );

    await expect(deleteN8nEndpoint(ctx, id)).resolves.toEqual({
      ok: true,
      message: 'Route entfernt.',
    });

    expect(await owner.n8nWebhookEndpoint.findUnique({ where: { id } })).toBeNull();
    expect(await owner.n8nEventSubscription.count({ where: { endpointId: id } })).toBe(0);
    expect((await owner.n8nDelivery.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
      'SKIPPED',
    );
    expect(await audits(id)).toEqual([
      expect.objectContaining({ action: 'tenant.settings.n8n.endpoint.upsert' }),
      {
        action: 'tenant.settings.n8n.endpoint.delete',
        after: { cancelledPendingDeliveries: 1 },
      },
    ]);
    fixture.revalidated = [];
    await expect(deleteN8nEndpoint(ctx, id)).resolves.toEqual({
      ok: false,
      error: 'Route nicht gefunden.',
    });
    expect(fixture.revalidated).toEqual([]);
  });

  it('ordnet ein UNROUTED-Event der aktiven Route zu (Test-URL im testMode) und reiht es ein', async () => {
    // Eigenes Workflow-Step-Event: keine andere Route dieser Suite abonniert es.
    const { input, id } = await savedRoute({
      testMode: true,
      events: ['workflow.step.k03-replay'],
    });
    const event = await outbox('workflow.step.k03-replay', 'UNROUTED');

    await expect(replayUnroutedN8nEvent(ctx, event.id)).resolves.toEqual({
      ok: true,
      message: '1 Ziel(e) zugeordnet.',
    });

    const created = await owner.n8nDelivery.findMany({ where: { outboxId: event.id } });
    expect(created).toEqual([
      expect.objectContaining({
        endpointId: id,
        connectionIdSnapshot: connectionId,
        endpointNameSnapshot: input.name,
        targetUrl: input.testUrl,
        status: 'PENDING',
      }),
    ]);
    expect((await owner.n8nOutbox.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      'PENDING',
    );
    expect(fixture.queued).toEqual([
      ['deliver', { deliveryId: created[0]!.id }, expect.objectContaining({ attempts: 6 })],
    ]);
    expect(await audits(event.id)).toEqual([
      {
        action: 'tenant.settings.n8n.event.replay',
        after: { event: 'workflow.step.k03-replay', deliveriesCreated: 1, skipped: 0 },
      },
    ]);
    await expect(replayUnroutedN8nEvent(ctx, event.id)).resolves.toEqual({
      ok: false,
      error: 'Das Event ist nicht mehr offen oder wurde bereits zugeordnet.',
    });
  });

  it('schließt ein UNROUTED-Event bewusst ohne Versand ab', async () => {
    const event = await outbox('client.created', 'UNROUTED');

    await expect(skipUnroutedN8nEvent(ctx, event.id)).resolves.toEqual({
      ok: true,
      message: 'Event wurde nachvollziehbar ohne Versand abgeschlossen.',
    });

    expect(await owner.n8nOutbox.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      status: 'SKIPPED',
      lastError: 'Durch Admin-Entscheidung ohne n8n-Versand abgeschlossen',
    });
    const [skipped] = await owner.n8nDelivery.findMany({ where: { outboxId: event.id } });
    expect(skipped).toMatchObject({
      status: 'SKIPPED',
      targetUrl: null,
      endpointNameSnapshot: 'Ohne Versand abgeschlossen',
    });
    expect(await audits(event.id)).toEqual([
      {
        action: 'tenant.settings.n8n.event.skip',
        after: expect.objectContaining({
          event: 'client.created',
          deliveryId: skipped!.id,
          decision: 'skip_without_delivery',
        }),
      },
    ]);
  });

  it('wiederholt eine fehlgeschlagene Zustellung nur an ihr unverändertes Ziel', async () => {
    const { input, id } = await savedRoute({ testMode: true });
    const endpoint = { id, name: input.name };
    const event = await outbox('client.created', 'FAILED');
    const failed = await delivery(event.id, endpoint, {
      targetUrl: input.testUrl,
      status: 'FAILED',
      lastError: 'HTTP 500',
    });
    const staleEvent = await outbox('client.created', 'FAILED');
    const stale = await delivery(staleEvent.id, endpoint, {
      targetUrl: input.productionUrl,
      status: 'FAILED',
    });

    await expect(retryN8nDelivery(ctx, failed.id)).resolves.toEqual({
      ok: true,
      message: 'Zustellung wurde erneut eingeplant.',
    });
    expect(await owner.n8nDelivery.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({
      status: 'PENDING',
      lastError: null,
    });
    expect((await owner.n8nOutbox.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      'PENDING',
    );
    expect(fixture.queued).toEqual([
      [
        'deliver',
        { deliveryId: failed.id },
        expect.objectContaining({
          jobId: expect.stringMatching(new RegExp(`^manual-retry-${failed.id}-`)),
        }),
      ],
    ]);
    expect(await audits(failed.id)).toEqual([
      {
        action: 'tenant.settings.n8n.delivery.retry',
        after: { outboxId: event.id, event: 'client.created', targetUrl: input.testUrl },
      },
    ]);

    // Alter Produktions-Snapshot einer Route im testMode: kein erneuter Versand.
    await expect(retryN8nDelivery(ctx, stale.id)).resolves.toEqual({
      ok: false,
      error:
        'Das ursprüngliche Ziel wurde geändert, deaktiviert oder entfernt. Alte Ziel-Snapshots werden nicht erneut gesendet.',
    });
    expect((await owner.n8nDelivery.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe(
      'FAILED',
    );
  });

  it('setzt eine nicht einreihbare Wiederholung wieder auf FAILED', async () => {
    const { input, id } = await savedRoute();
    const event = await outbox('client.created', 'FAILED');
    const failed = await delivery(
      event.id,
      { id, name: input.name },
      { targetUrl: input.productionUrl, status: 'FAILED' },
    );
    fixture.queueError = new Error('redis down');

    await expect(retryN8nDelivery(ctx, failed.id)).resolves.toEqual({
      ok: false,
      error: 'Retry konnte nicht in die Queue eingereiht werden.',
    });

    const row = await owner.n8nDelivery.findUniqueOrThrow({ where: { id: failed.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toMatch(/^Retry konnte nicht eingeplant werden: /);
    expect(row.lastError).not.toContain('redis down');
    expect((await owner.n8nOutbox.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
      'FAILED',
    );
    expect(fixture.revalidated).toEqual(SETTINGS_PAGES);
  });

  it('listet offene Fehler und quittiert sie revisionssicher', async () => {
    const { input, id } = await savedRoute();
    const event = await outbox('client.created', 'FAILED');
    const failed = await delivery(
      event.id,
      { id, name: input.name },
      { targetUrl: input.productionUrl, status: 'FAILED', lastError: 'HTTP 410' },
    );

    const page = await listFailedN8nDeliveries(ctx, null);
    expect(page.ok).toBe(true);
    expect(page.deliveries.map((item) => item.id)).toContain(failed.id);
    expect(page.nextCursor).toBeNull();

    await expect(acknowledgeN8nDelivery(ctx, failed.id)).resolves.toEqual({
      ok: true,
      message: 'Fehler wurde revisionsprotokolliert quittiert.',
    });
    expect(await owner.n8nDelivery.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({
      status: 'SKIPPED',
      lastError: 'Administrativ quittiert. Ursprünglicher Fehler: HTTP 410',
    });
    expect(await audits(failed.id)).toEqual([
      {
        action: 'tenant.settings.n8n.delivery.acknowledge',
        after: {
          status: 'SKIPPED',
          outboxId: event.id,
          targetUrl: input.productionUrl,
          reason: 'operator_acknowledged',
        },
      },
    ]);
    await expect(acknowledgeN8nDelivery(ctx, failed.id)).resolves.toEqual({
      ok: false,
      error: 'Nur offene fehlgeschlagene Zustellungen können quittiert werden.',
    });
  });

  it('setzt die Integration zurück: Routen und Credentials entfernt, Zustellungen abgebrochen', async () => {
    const { input, id } = await savedRoute();
    const event = await outbox('client.created', 'PENDING');
    const pending = await delivery(
      event.id,
      { id, name: input.name },
      { targetUrl: input.productionUrl, status: 'PENDING' },
    );

    const result = await resetN8nConnection(ctx);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(
      /^Integration deaktiviert; Credentials und Routen entfernt \(\d+ wartende Zustellungen abgebrochen\)\.$/,
    );
    expect(await owner.n8nWebhookEndpoint.count({ where: { tenantId } })).toBe(0);
    expect((await owner.n8nDelivery.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
      'SKIPPED',
    );
    expect(
      await owner.n8nConnection.findUniqueOrThrow({
        where: { id: connectionId },
        select: {
          routingMode: true,
          enabled: true,
          signingSecretEncrypted: true,
          apiKeyEncrypted: true,
          callbackTokenHash: true,
        },
      }),
    ).toEqual({
      routingMode: 'DISABLED',
      enabled: false,
      signingSecretEncrypted: null,
      apiKeyEncrypted: null,
      callbackTokenHash: null,
    });
    expect((await audits(connectionId)).at(-1)).toEqual({
      action: 'tenant.settings.n8n.delete',
      after: expect.objectContaining({
        disabled: true,
        routesRemoved: true,
        credentialsRemoved: true,
      }),
    });
    expect(fixture.revalidated).toEqual(SETTINGS_PAGES);
    await expectIntactChainTail();
  });
});
