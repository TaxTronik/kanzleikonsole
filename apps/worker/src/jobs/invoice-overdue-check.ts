// =============================================================================
// invoice-overdue-check-Worker
//
// Findet alle SENT-Rechnungen, deren Fälligkeit überschritten ist, setzt
// status=OVERDUE und benachrichtigt den Ersteller (createdByStaff).
// =============================================================================

import { Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';


export const invoiceOverdueWorker = new Worker<ChecksJob>(
  'invoice-overdue-check',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    let updated = 0;
    let notified = 0;

    for (const tenantId of tenantIds) {
      const now = new Date();
      const overdue = await prismaOwner.invoice.findMany({
        where: {
          tenantId,
          status: 'SENT',
          dueDate: { lt: now },
        },
        include: { client: { select: { name: true } } },
      });

      for (const inv of overdue) {
        // U-1: Status-Update + Notification in einer Tenant-Context-Transaktion.
        // Vorher: lose Sequenz auf prismaOwner ohne TX → Race + kein RLS-/Audit-
        // Context. P2002-Catch fängt parallele Trigger ab.
        const daysOverdue = Math.ceil((now.getTime() - inv.dueDate.getTime()) / (24 * 60 * 60 * 1000));
        try {
          await withWorkerTenantContext(tenantId, async (tx) => {
            await tx.invoice.update({
              where: { id: inv.id },
              data: { status: 'OVERDUE' },
            });
            const data = {
              tenantId,
              staffId: inv.createdByStaff,
              kind: 'INVOICE_OVERDUE' as const,
              title: `Rechnung ${inv.number} überfällig (${daysOverdue} Tag${daysOverdue === 1 ? '' : 'e'})`,
              body: `Mandant: ${inv.client.name} · Brutto: ${Number(inv.totalAmount.toString()).toFixed(2)} €`,
              href: `/staff/invoices/${inv.id}`,
              resourceType: 'invoice',
              resourceId: inv.id,
            };
            const existing = await tx.notification.findFirst({
              where: {
                tenantId,
                staffId: inv.createdByStaff,
                kind: 'INVOICE_OVERDUE',
                resourceType: 'invoice',
                resourceId: inv.id,
                readAt: null,
              },
            });
            if (existing) {
              await tx.notification.update({
                where: { id: existing.id },
                data: { ...data, createdAt: new Date() },
              });
            } else {
              await tx.notification.create({ data });
              notified++;
            }
          });
          updated++;
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
            // Idempotenz-Index hat parallelen Insert bereits zugelassen.
            continue;
          }
          throw err;
        }
      }
    }

    log.info({ updated, notified }, 'invoice-overdue: done');
    return { updated, notified };
  },
  { connection, concurrency: 1 },
);

invoiceOverdueWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'invoice-overdue: failed');
});
