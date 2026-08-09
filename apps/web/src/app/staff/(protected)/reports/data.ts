import type { Prisma } from '@prisma/client';

async function loadBillingReports(
  tx: Prisma.TransactionClient,
  startOfYear: Date,
  ninetyDaysAgo: Date,
) {
  const [invoiceStatusSums, invoicesYTD, paidInvoicesAvgPaymentDays, topClientsByRevenue] =
    await Promise.all([
      tx.invoice.groupBy({
        by: ['status'],
        _sum: { totalAmount: true },
        _count: { _all: true },
      }),
      tx.invoice.aggregate({
        // Storno-Belege (negierte Beträge, stornoOfId gesetzt) NICHT mitzählen:
        // das stornierte Original ist über status=CANCELLED bereits ausgeschlossen;
        // der negative Storno würde den Umsatz sonst ein zweites Mal mindern.
        where: { issueDate: { gte: startOfYear }, status: { not: 'CANCELLED' }, stornoOfId: null },
        _sum: { totalAmount: true, netAmount: true },
        _count: { _all: true },
      }),
      tx.$queryRaw<Array<{ avg_days: number | null }>>`
        SELECT AVG(EXTRACT(EPOCH FROM (paid_at - issue_date::timestamp)) / 86400)::float AS avg_days
        FROM invoice
        WHERE tenant_id = app.current_tenant_id()
          AND status = 'PAID'
          AND paid_at IS NOT NULL
          AND issue_date >= ${ninetyDaysAgo}
      `,
      tx.$queryRaw<Array<{ client_id: string; name: string; revenue: number }>>`
        SELECT
          c.id::text AS client_id,
          c.name,
          SUM(i.net_amount)::float AS revenue
        FROM client c
        JOIN invoice i ON i.client_id = c.id
        WHERE c.tenant_id = app.current_tenant_id()
          AND i.issue_date >= ${startOfYear}
          AND i.status <> 'CANCELLED'
          AND i.storno_of_id IS NULL
        GROUP BY c.id, c.name
        ORDER BY revenue DESC
        LIMIT 5
      `,
    ]);

  return {
    invoiceStatusSums,
    invoicesYTD,
    paidInvoicesAvgPaymentDays: paidInvoicesAvgPaymentDays[0]?.avg_days ?? null,
    topClientsByRevenue,
  };
}

export async function loadReports(tx: Prisma.TransactionClient, includeBilling: boolean) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const [
    requestStatusCounts,
    overdueRequests,
    requestsLast30,
    avgResponseTime,
    timeEntriesMonth,
    topClientsByHours,
  ] = await Promise.all([
    tx.request.groupBy({
      by: ['status'],
      _count: { _all: true },
    }),
    tx.request.count({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        dueAt: { not: null, lt: now },
      },
    }),
    tx.request.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    tx.$queryRaw<Array<{ avg_seconds: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM (first_response.created_at - r.created_at)))::float AS avg_seconds
      FROM request r
      JOIN LATERAL (
        SELECT created_at FROM request_response
        WHERE request_id = r.id AND author_type = 'CLIENT_CONTACT'
        ORDER BY created_at ASC LIMIT 1
      ) AS first_response ON true
      WHERE r.tenant_id = app.current_tenant_id()
        AND r.created_at >= ${ninetyDaysAgo}
    `,
    tx.timeEntry.aggregate({
      where: { startedAt: { gte: startOfMonth } },
      _count: { _all: true },
    }),
    tx.$queryRaw<Array<{ client_id: string; name: string; minutes: number }>>`
      SELECT
        c.id::text AS client_id,
        c.name,
        COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(t.ended_at, NOW()) - t.started_at))/60), 0)::int AS minutes
      FROM client c
      JOIN time_entry t ON t.client_id = c.id
      WHERE c.tenant_id = app.current_tenant_id()
        AND t.started_at >= ${ninetyDaysAgo}
        AND t.billable
      GROUP BY c.id, c.name
      ORDER BY minutes DESC
      LIMIT 5
    `,
  ]);

  // Finanzdaten werden ausschließlich für ADMIN/PARTNER abgefragt. Dadurch
  // schützt die Server-Seite auch direkte Aufrufe, nicht nur die Darstellung.
  const billing = includeBilling ? await loadBillingReports(tx, startOfYear, ninetyDaysAgo) : null;

  return {
    requestStatusCounts,
    overdueRequests,
    requestsLast30,
    avgResponseTime: avgResponseTime[0]?.avg_seconds ?? null,
    timeEntriesMonth: timeEntriesMonth._count._all,
    topClientsByHours,
    billing,
  };
}
