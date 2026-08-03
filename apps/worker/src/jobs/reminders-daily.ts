// =============================================================================
// reminders-daily-Worker
//
// Tägliche Sammlung von Reminder-Notifications:
//   - Einspruchsfristen (TaxNotice.appealDeadline): 14 / 7 / 1 Tage davor
//   - Wiedervorlagen (ClientReminder.dueDate): heute fällig + überfällig
//   - Pendelordner (PendingBinder.expectedReturnAt): überfällig
//
// Idempotent über die `notification`-Tabelle: heutige Dedupe-Keys werden pro
// Tenant einmal als Set geladen; die verbleibenden Einträge gehen sanitisiert
// per createMany(skipDuplicates) in den Daily-Dedupe-Index.
// =============================================================================

import { Worker } from 'bullmq';
import type { NotificationKind } from '@prisma/client';
import { sanitizeNotificationText } from '@taxtronik/db/notification';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { berlinTodayUtcMidnight, wholeDaysBetween } from '../date-util';

const DAY_MS = 24 * 60 * 60 * 1000;
const CREATE_MANY_BATCH_SIZE = 1000;
const APPEAL_REMINDER_DAYS = [1, 7, 14] as const;

interface DailyNotification {
  staffId: string | null;
  kind: NotificationKind;
  resourceType: string;
  resourceId: string;
  title: string;
  body: string;
  href: string;
}

function dailyNotificationKey(notification: {
  staffId: string | null;
  kind: NotificationKind;
  resourceId: string | null;
}): string {
  return JSON.stringify([notification.staffId, notification.kind, notification.resourceId]);
}

async function createDailyNotifications(
  tenantId: string,
  now: Date,
  groups: DailyNotification[][],
): Promise<number[]> {
  const candidates = groups.flat();
  if (candidates.length === 0) return groups.map(() => 0);

  // Der Daily-Dedupe-Index bucketisiert created_at in UTC-Tage. Mit exakt
  // demselben Fenster eliminiert die Vorab-Abfrage bekannte Keys als Set;
  // createMany(skipDuplicates) bleibt der Race-Backstop.
  const createdAtGte = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const createdAtLt = new Date(createdAtGte.getTime() + DAY_MS);

  return withWorkerTenantContext(tenantId, async (tx) => {
    const existing = await tx.notification.findMany({
      where: {
        tenantId,
        createdAt: { gte: createdAtGte, lt: createdAtLt },
        kind: { in: Array.from(new Set(candidates.map((candidate) => candidate.kind))) },
      },
      select: { staffId: true, kind: true, resourceId: true },
    });
    const seen = new Set(existing.map(dailyNotificationKey));
    const insertedCounts: number[] = [];

    for (const group of groups) {
      const pending = group.filter((candidate) => {
        const key = dailyNotificationKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (pending.length === 0) {
        insertedCounts.push(0);
        continue;
      }

      let inserted = 0;
      for (let offset = 0; offset < pending.length; offset += CREATE_MANY_BATCH_SIZE) {
        const batch = pending.slice(offset, offset + CREATE_MANY_BATCH_SIZE);
        const result = await tx.notification.createMany({
          data: batch.map((candidate) => ({
            tenantId,
            staffId: candidate.staffId,
            kind: candidate.kind,
            title: sanitizeNotificationText(candidate.title),
            body: sanitizeNotificationText(candidate.body),
            href: candidate.href,
            resourceType: candidate.resourceType,
            resourceId: candidate.resourceId,
          })),
          skipDuplicates: true,
        });
        inserted += result.count;
      }
      insertedCounts.push(inserted);
    }

    return insertedCounts;
  });
}

export const remindersDailyWorker = new Worker<ChecksJob>(
  'reminders-daily',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    const now = new Date();
    const today = berlinTodayUtcMidnight(now);
    const appealDates = APPEAL_REMINDER_DAYS.map(
      (days) => new Date(today.getTime() + days * DAY_MS),
    );
    const counts = { appeal: 0, reminders: 0, binders: 0 };

    for (const tenantId of tenantIds) {
      const [notices, reminders, binders] = await Promise.all([
        // Exakt die drei relevanten @db.Date-Tage statt aller künftigen
        // Bescheide zu laden und anschließend im Worker zu filtern.
        prismaOwner.taxNotice.findMany({
          where: {
            tenantId,
            client: { mandateEndedAt: null },
            appealDeadline: { in: appealDates },
            appealFiledAt: null,
            status: { notIn: ['EINSPRUCH', 'ABGEHOLFEN', 'ZURUECKGEWIESEN', 'RECHTSKRAEFTIG'] },
          },
          select: {
            id: true,
            kind: true,
            period: true,
            appealDeadline: true,
            client: { select: { id: true, name: true } },
            reviewedBy: true,
          },
        }),
        prismaOwner.clientReminder.findMany({
          where: {
            tenantId,
            // Interne Aufgaben haben keinen Mandanten — der Mandats-Filter
            // darf sie nicht mit aussortieren.
            OR: [{ clientId: null }, { client: { mandateEndedAt: null } }],
            doneAt: null,
            dueDate: { lte: today },
          },
          select: {
            id: true,
            dueDate: true,
            subject: true,
            assignees: { select: { staffId: true } },
            createdByStaff: true,
            client: { select: { id: true, name: true } },
          },
        }),
        prismaOwner.pendingBinder.findMany({
          where: {
            tenantId,
            client: { mandateEndedAt: null },
            status: 'WITH_CLIENT',
            expectedReturnAt: { not: null, lt: today },
          },
          select: {
            id: true,
            label: true,
            expectedReturnAt: true,
            createdByStaff: true,
            client: { select: { id: true, name: true } },
          },
        }),
      ]);

      const appealNotifications: DailyNotification[] = [];
      for (const n of notices) {
        if (!n.appealDeadline) continue;
        const days = wholeDaysBetween(today, n.appealDeadline);
        // Defense in depth für Mock-/Altwerte; die Query ist bereits exakt.
        if (days !== 1 && days !== 7 && days !== 14) continue;
        const labelDays = days === 1 ? 'morgen' : `in ${days} Tagen`;
        appealNotifications.push({
          staffId: n.reviewedBy,
          kind: 'TAX_NOTICE_APPEAL_REMINDER',
          resourceType: 'tax_notice',
          resourceId: n.id,
          title: `Einspruchsfrist ${labelDays}: ${n.client.name}`,
          body: `${n.kind} ${n.period} — Frist ${n.appealDeadline.toISOString().slice(0, 10)}`,
          href: `/staff/clients/${n.client.id}/notices`,
        });
      }

      // Bei mehreren Zustaendigen bekommt JEDE Person die Faelligkeit — die
      // Aufgabe bleibt dieselbe, aber erinnert werden muessen alle. Ohne
      // Zuweisung erinnert sich die anlegende Person selbst.
      const reminderNotifications: DailyNotification[] = reminders.flatMap((reminder) => {
        const empfaenger =
          reminder.assignees.length > 0
            ? reminder.assignees.map((a) => a.staffId)
            : [reminder.createdByStaff];
        const wo = reminder.client ? `Mandant ${reminder.client.name}` : 'Intern';
        return empfaenger.map((staffId) => ({
          staffId,
          kind: 'CLIENT_REMINDER_DUE' as const,
          resourceType: 'client_reminder',
          resourceId: reminder.id,
          title: `Wiedervorlage fällig: ${reminder.subject}`,
          body: `${wo} · ${reminder.dueDate.toISOString().slice(0, 10)}`,
          href: reminder.client ? `/staff/clients/${reminder.client.id}` : '/staff/reminders',
        }));
      });

      const binderNotifications: DailyNotification[] = [];
      for (const binder of binders) {
        if (!binder.expectedReturnAt) continue;
        const days = wholeDaysBetween(binder.expectedReturnAt, today);
        binderNotifications.push({
          staffId: binder.createdByStaff,
          kind: 'PENDING_BINDER_OVERDUE',
          resourceType: 'pending_binder',
          resourceId: binder.id,
          title: `Pendelordner überfällig: ${binder.label}`,
          body: `Mandant ${binder.client.name} — seit ${days} Tag${days === 1 ? '' : 'en'} ausstehend`,
          href: `/staff/clients/${binder.client.id}`,
        });
      }

      const [appeal, reminderCount, binderCount] = await createDailyNotifications(tenantId, now, [
        appealNotifications,
        reminderNotifications,
        binderNotifications,
      ]);
      counts.appeal += appeal ?? 0;
      counts.reminders += reminderCount ?? 0;
      counts.binders += binderCount ?? 0;
    }

    log.info(counts, 'reminders-daily: done');
    return counts;
  },
  { connection, concurrency: 1 },
);

remindersDailyWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'reminders-daily: failed');
});
