// =============================================================================
// reminders-daily-Worker
//
// Tägliche Sammlung von Reminder-Notifications:
//   - Einspruchsfristen (TaxNotice.appealDeadline): 14 / 7 / 1 Tage davor
//   - Wiedervorlagen (ClientReminder.dueDate): heute fällig + überfällig
//   - Pendelordner (PendingBinder.expectedReturnAt): überfällig
//
// Idempotent über die `notification`-Tabelle: pro (resourceType, resourceId,
// kind, day-bucket) wird nur einmal eine Notification geschrieben — der
// day-bucket ist ein YYYY-MM-DD-Stempel im title/body, damit der unique-
// Check über (kind, resourceId, createdAt::date) faktisch funktioniert.
//
// Soft-Idempotenz: wir prüfen vor jedem Insert, ob es heute bereits einen
// solchen Eintrag gibt — kein Schema-Lock nötig.
// =============================================================================

import { Worker } from 'bullmq';
import prismaClientPkg from '@prisma/client';
const { Prisma } = prismaClientPkg;
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';


function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / (24 * 60 * 60 * 1000));
}

async function notifyOnce(opts: {
  tenantId: string;
  staffId: string | null;
  kind: 'TAX_NOTICE_APPEAL_REMINDER' | 'CLIENT_REMINDER_DUE' | 'PENDING_BINDER_OVERDUE';
  resourceType: string;
  resourceId: string;
  title: string;
  body: string;
  href: string;
}): Promise<boolean> {
  // Q-2: Statt findFirst-then-create (race-anfällig) verlassen wir uns auf den
  // partial unique index `notification_daily_dedupe` (Migration iter49). Bei
  // parallelem Insert für dieselbe (tenant_id, kind, resource_id, Tag) wirft
  // Postgres P2002 — wir interpretieren das als „heute schon vorhanden, ok".
  //
  // P-8/Q-2 RLS-Symmetrie: Insert läuft jetzt in withWorkerTenantContext, damit
  // app.current_*-Variablen für Audit-Trigger / etwaige RLS-Policies konsistent
  // gesetzt sind. prismaOwner ist BYPASSRLS, aber das Pattern soll überall
  // gleich aussehen.
  try {
    await withWorkerTenantContext(opts.tenantId, async (tx) => {
      await tx.notification.create({
        data: {
          tenantId: opts.tenantId,
          staffId: opts.staffId,
          kind: opts.kind,
          title: opts.title,
          body: opts.body,
          href: opts.href,
          resourceType: opts.resourceType,
          resourceId: opts.resourceId,
        },
      });
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // unique-Constraint vom Daily-Dedupe-Index — heute schon geschrieben
      return false;
    }
    throw err;
  }
}

export const remindersDailyWorker = new Worker<ChecksJob>(
  'reminders-daily',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    const now = new Date();
    const today = startOfDay(now);
    let counts = { appeal: 0, reminders: 0, binders: 0 };

    for (const tenantId of tenantIds) {
      // ---- Einspruchsfristen ----
      const notices = await prismaOwner.taxNotice.findMany({
        where: {
          tenantId,
          appealDeadline: { not: null, gte: today },
          appealFiledAt: null,
          // Nur erinnern, solange noch handelbar: kein Einspruch eingelegt und
          // nicht abgeschlossen. (Kein `as never` — die echten Enum-Werte werden
          // jetzt typgeprüft.)
          status: { notIn: ['EINSPRUCH', 'ABGEHOLFEN', 'ZURUECKGEWIESEN', 'RECHTSKRAEFTIG'] },
        },
        select: {
          id: true, kind: true, period: true, appealDeadline: true,
          client: { select: { id: true, name: true } },
          reviewedBy: true,
        },
      });
      for (const n of notices) {
        if (!n.appealDeadline) continue;
        const days = daysBetween(n.appealDeadline, today);
        if (days !== 14 && days !== 7 && days !== 1) continue;
        const labelDays = days === 1 ? 'morgen' : `in ${days} Tagen`;
        const sent = await notifyOnce({
          tenantId,
          staffId: n.reviewedBy ?? null, // an den Prüfer, sonst global (null)
          kind: 'TAX_NOTICE_APPEAL_REMINDER',
          resourceType: 'tax_notice',
          resourceId: n.id,
          title: `Einspruchsfrist ${labelDays}: ${n.client.name}`,
          body: `${n.kind} ${n.period} — Frist ${n.appealDeadline.toISOString().slice(0, 10)}`,
          href: `/staff/clients/${n.client.id}/notices`,
        });
        if (sent) counts.appeal++;
      }

      // ---- Wiedervorlagen ----
      const reminders = await prismaOwner.clientReminder.findMany({
        where: {
          tenantId,
          doneAt: null,
          dueDate: { lte: today },
        },
        select: {
          id: true, dueDate: true, subject: true, assigneeStaffId: true, createdByStaff: true,
          client: { select: { id: true, name: true } },
        },
      });
      for (const r of reminders) {
        const recipient = r.assigneeStaffId ?? r.createdByStaff;
        const sent = await notifyOnce({
          tenantId,
          staffId: recipient,
          kind: 'CLIENT_REMINDER_DUE',
          resourceType: 'client_reminder',
          resourceId: r.id,
          title: `Wiedervorlage fällig: ${r.subject}`,
          body: `Mandant ${r.client.name} · ${r.dueDate.toISOString().slice(0, 10)}`,
          href: `/staff/clients/${r.client.id}`,
        });
        if (sent) counts.reminders++;
      }

      // ---- Überfällige Pendelordner ----
      const binders = await prismaOwner.pendingBinder.findMany({
        where: {
          tenantId,
          status: 'WITH_CLIENT',
          expectedReturnAt: { not: null, lt: today },
        },
        select: {
          id: true, label: true, expectedReturnAt: true, createdByStaff: true,
          client: { select: { id: true, name: true } },
        },
      });
      for (const b of binders) {
        if (!b.expectedReturnAt) continue;
        const overdueDays = daysBetween(today, b.expectedReturnAt);
        const sent = await notifyOnce({
          tenantId,
          staffId: b.createdByStaff,
          kind: 'PENDING_BINDER_OVERDUE',
          resourceType: 'pending_binder',
          resourceId: b.id,
          title: `Pendelordner überfällig: ${b.label}`,
          body: `Mandant ${b.client.name} — seit ${overdueDays} Tag${overdueDays === 1 ? '' : 'en'} ausstehend`,
          href: `/staff/clients/${b.client.id}`,
        });
        if (sent) counts.binders++;
      }
    }

    log.info(counts, 'reminders-daily: done');
    return counts;
  },
  { connection, concurrency: 1 },
);

remindersDailyWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'reminders-daily: failed');
});
