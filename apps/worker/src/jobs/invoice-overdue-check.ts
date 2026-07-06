// =============================================================================
// invoice-overdue-check-Worker
//
// Findet alle SENT-Rechnungen, deren Fälligkeit überschritten ist, setzt
// status=OVERDUE und benachrichtigt den Ersteller (createdByStaff).
// =============================================================================

import { Worker } from 'bullmq';
import { Prisma } from '@taxtronik/db/prisma-client';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';

// RF-8: record() braucht nur den Tx — gleiches Muster wie risk-analyse-llm.ts.
const evidence = new EvidenceService(new LocalTimestampAdapter());

/**
 * UTC-Mitternacht des HEUTIGEN Kalendertags in Europe/Berlin. `dueDate` ist
 * `@db.Date` (UTC-Mitternacht des Fälligkeitstags). Eine Zahlung AM
 * Fälligkeitstag ist rechtzeitig (§ 271, § 188 Abs. 1 BGB) — überfällig ist
 * eine Rechnung erst ab dem Folgetag, also `dueDate < heute 00:00 (Berlin)`.
 */
export function berlinTodayUtcMidnight(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year')!.value);
  const m = Number(parts.find((p) => p.type === 'month')!.value);
  const d = Number(parts.find((p) => p.type === 'day')!.value);
  return new Date(Date.UTC(y, m - 1, d));
}

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
      // Überfällig erst ab dem Tag NACH der Fälligkeit (Zahlung am
      // Fälligkeitstag ist rechtzeitig, § 271 BGB).
      const todayMidnight = berlinTodayUtcMidnight(now);
      const overdue = await prismaOwner.invoice.findMany({
        where: {
          tenantId,
          status: 'SENT',
          dueDate: { lt: todayMidnight },
          // Stornorechnungen (Gutschriften, negative Beträge) sind keine offene
          // Forderung — nicht als „überfällig" markieren.
          stornoOfId: null,
        },
        include: { client: { select: { name: true } } },
      });

      for (const inv of overdue) {
        // U-1: Status-Update + Notification in einer Tenant-Context-Transaktion.
        // Vorher: lose Sequenz auf prismaOwner ohne TX → Race + kein RLS-/Audit-
        // Context. P2002-Catch fängt parallele Trigger ab.
        // daysOverdue aus dem Abstand zweier UTC-Mitternachte (exakte
        // Tagesvielfache) → am ersten Folgetag genau „1 Tag überfällig".
        const daysOverdue = Math.round(
          (todayMidnight.getTime() - inv.dueDate.getTime()) / (24 * 60 * 60 * 1000),
        );
        try {
          const applied = await withWorkerTenantContext(tenantId, async (tx) => {
            // Status-Recheck IN der Tx: zwischen findMany und hier kann die
            // Rechnung bezahlt/storniert worden sein. SENT→OVERDUE nur, solange
            // noch SENT — sonst würfe der iter85-Trigger restrict_violation
            // (z. B. PAID→OVERDUE), was den ganzen Job-Lauf abbräche.
            const res = await tx.invoice.updateMany({
              where: { id: inv.id, status: 'SENT' },
              data: { status: 'OVERDUE' },
            });
            if (res.count === 0) return false;
            // RF-8: System-Statuswechsel in die Audit-Chain — derselbe TX wie
            // das Update (vorher fehlte der evidence.record komplett).
            await evidence.record(tx, {
              tenantId,
              actorType: 'SYSTEM',
              actorId: null,
              action: 'invoice.overdue',
              resourceType: 'invoice',
              resourceId: inv.id,
              before: { status: 'SENT' },
              after: { status: 'OVERDUE', daysOverdue },
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
            return true;
          });
          if (applied) updated++;
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
