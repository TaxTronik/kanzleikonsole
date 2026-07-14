import { withTenantContext, type TenantContext } from '@taxtronik/db';

export interface N8nEndpointView {
  id: string;
  name: string;
  productionUrl: string;
  testUrl: string;
  workflowId: string;
  workflowName: string;
  workflowNodeId: string;
  source: 'MANAGED' | 'DISCOVERED' | 'CUSTOM' | 'LEGACY';
  enabled: boolean;
  verifiedAt: string | null;
  verificationOk: boolean | null;
  verificationError: string | null;
  events: string[];
}

export interface N8nRecentDeliveryView {
  id: string;
  eventId: string;
  event: string;
  endpoint: string;
  targetUrl: string;
  status: 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'FAILED' | 'SKIPPED';
  attempts: number;
  httpStatus: number | null;
  latencyMs: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface N8nSetupStatus {
  connectionId: string | null;
  enabled: boolean;
  routingMode: 'DISABLED' | 'LEGACY' | 'EXPLICIT';
  callbackConfigured: boolean;
  endpointCount: number;
  activeEndpointCount: number;
  subscriptionCount: number;
  deliveryCounts: {
    pending: number;
    delivered: number;
    failed: number;
    skipped: number;
    unrouted: number;
  };
  unroutedEvents: { event: string; count: number }[];
  recentUnroutedEvents: {
    id: string;
    event: string;
    occurredAt: string;
    lastError: string | null;
  }[];
  endpoints: N8nEndpointView[];
  failedDeliveries: N8nRecentDeliveryView[];
  hasMoreFailedDeliveries: boolean;
  recentDeliveries: N8nRecentDeliveryView[];
}

interface N8nDeliveryViewRow {
  id: string;
  endpointNameSnapshot: string;
  targetUrl: string | null;
  status: N8nRecentDeliveryView['status'];
  attempts: number;
  httpStatus: number | null;
  latencyMs: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  outbox: { id: string; event: string };
}

export function toN8nRecentDeliveryView(delivery: N8nDeliveryViewRow): N8nRecentDeliveryView {
  return {
    id: delivery.id,
    eventId: delivery.outbox.id,
    event: delivery.outbox.event,
    endpoint: delivery.endpointNameSnapshot,
    targetUrl: delivery.targetUrl ?? '',
    status: delivery.status,
    attempts: delivery.attempts,
    httpStatus: delivery.httpStatus,
    latencyMs: delivery.latencyMs,
    lastError: delivery.lastError,
    createdAt: delivery.createdAt.toISOString(),
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
  };
}

export async function readN8nSetupStatus(ctx: TenantContext): Promise<N8nSetupStatus> {
  return withTenantContext(ctx, async (tx) => {
    const connection = await tx.n8nConnection.findUnique({
      where: { tenantId: ctx.tenantId },
      include: {
        endpoints: {
          orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
          include: {
            subscriptions: {
              where: { enabled: true },
              orderBy: { event: 'asc' },
              select: { event: true },
            },
          },
        },
      },
    });

    const [pending, delivered, failed, skipped, unrouted, recent, failedRows, unroutedRows] =
      await Promise.all([
        tx.n8nDelivery.count({
          where: { tenantId: ctx.tenantId, status: { in: ['PENDING', 'PROCESSING'] } },
        }),
        tx.n8nDelivery.count({ where: { tenantId: ctx.tenantId, status: 'DELIVERED' } }),
        tx.n8nDelivery.count({ where: { tenantId: ctx.tenantId, status: 'FAILED' } }),
        tx.n8nDelivery.count({ where: { tenantId: ctx.tenantId, status: 'SKIPPED' } }),
        tx.n8nOutbox.count({ where: { tenantId: ctx.tenantId, status: 'UNROUTED' } }),
        tx.n8nDelivery.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: { outbox: { select: { id: true, event: true } } },
        }),
        tx.n8nDelivery.findMany({
          where: { tenantId: ctx.tenantId, status: 'FAILED' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 51,
          include: { outbox: { select: { id: true, event: true } } },
        }),
        tx.n8nOutbox.findMany({
          where: { tenantId: ctx.tenantId, status: 'UNROUTED' },
          orderBy: { createdAt: 'desc' },
          take: 500,
          select: { id: true, event: true, occurredAt: true, lastError: true },
        }),
      ]);

    const unroutedMap = new Map<string, number>();
    for (const row of unroutedRows) {
      unroutedMap.set(row.event, (unroutedMap.get(row.event) ?? 0) + 1);
    }

    const endpoints: N8nEndpointView[] =
      connection?.endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        productionUrl: endpoint.productionUrl,
        testUrl: endpoint.testUrl ?? '',
        workflowId: endpoint.workflowId ?? '',
        workflowName: endpoint.workflowName ?? '',
        workflowNodeId: endpoint.workflowNodeId ?? '',
        source: endpoint.source,
        enabled: endpoint.enabled,
        verifiedAt: endpoint.verifiedAt?.toISOString() ?? null,
        verificationOk: endpoint.verificationOk,
        verificationError: endpoint.verificationError,
        events: endpoint.subscriptions.map((subscription) => subscription.event),
      })) ?? [];

    return {
      connectionId: connection?.id ?? null,
      enabled: connection?.enabled ?? false,
      routingMode: connection?.routingMode ?? 'DISABLED',
      callbackConfigured: Boolean(connection?.callbackTokenHash),
      endpointCount: endpoints.length,
      activeEndpointCount: endpoints.filter((endpoint) => endpoint.enabled).length,
      subscriptionCount: endpoints.reduce((sum, endpoint) => sum + endpoint.events.length, 0),
      deliveryCounts: { pending, delivered, failed, skipped, unrouted },
      unroutedEvents: [...unroutedMap.entries()]
        .map(([event, count]) => ({ event, count }))
        .sort((a, b) => b.count - a.count || a.event.localeCompare(b.event)),
      recentUnroutedEvents: unroutedRows.slice(0, 20).map((item) => ({
        id: item.id,
        event: item.event,
        occurredAt: item.occurredAt.toISOString(),
        lastError: item.lastError,
      })),
      endpoints,
      failedDeliveries: failedRows.slice(0, 50).map(toN8nRecentDeliveryView),
      hasMoreFailedDeliveries: failedRows.length > 50,
      recentDeliveries: recent.map(toN8nRecentDeliveryView),
    };
  });
}
