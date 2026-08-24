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
//
// Fachregeln: TAX-NOTICE-APPEAL-001, TAX-CONTROL-STATUS-001
// =============================================================================

import { Worker } from 'bullmq';
import type { NotificationKind } from '@prisma/client';
import { Prisma } from '@taxtronik/db/prisma-client';
import { sanitizeNotificationText } from '@taxtronik/db/notification';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import type { TxClient } from '@taxtronik/db/tenant-context';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { berlinTodayUtcMidnight, wholeDaysBetween } from '../date-util';
import { readWorkerTenantModules } from '../module-gate';

const DAY_MS = 24 * 60 * 60 * 1000;
const CREATE_MANY_BATCH_SIZE = 1000;
const APPEAL_REMINDER_DAYS = [1, 7, 14] as const;
const CLOSED_APPEAL_NOTICE_STATUSES = [
  'EINSPRUCH',
  'ABGEHOLFEN',
  'TEILABHILFE',
  'TEILEINSPRUCHSENTSCHEIDUNG',
  'ZURUECKGEWIESEN',
  'KLAGE',
  'BESTANDSKRAEFTIG',
] as const;

interface DailyNotification {
  staffId: string | null;
  kind: NotificationKind;
  resourceType: string;
  resourceId: string;
  title: string;
  body: string;
  href: string;
  /** Nur fuer den unmittelbar vor Persistenz ausgefuehrten Empfaenger-Check. */
  clientId?: string | null;
  /**
   * Gesetzliche Frist: Empfaenger und Fristqualifikation im Insert-Tx erneut
   * aus dem aktuellen TaxNotice-/Mandantenzugriffsstand bestimmen.
   */
  recipientPolicy?: 'TAX_NOTICE_DEADLINE' | 'CLIENT_REMINDER_DUE' | 'PENDING_BINDER_OVERDUE';
  deadlineAt?: Date;
}

function dailyNotificationKey(notification: {
  staffId: string | null;
  kind: NotificationKind;
  resourceId: string | null;
}): string {
  return JSON.stringify([notification.staffId, notification.kind, notification.resourceId]);
}

async function lockDailyNotificationSourcesTx(
  tx: TxClient,
  tenantId: string,
  groups: DailyNotification[][],
): Promise<void> {
  const sourceIds = (policy: NonNullable<DailyNotification['recipientPolicy']>) =>
    [
      ...new Set(
        groups
          .flat()
          .filter((candidate) => candidate.recipientPolicy === policy)
          .map((candidate) => candidate.resourceId),
      ),
    ].sort();

  const noticeIds = sourceIds('TAX_NOTICE_DEADLINE');
  const reminderIds = sourceIds('CLIENT_REMINDER_DUE');
  const binderIds = sourceIds('PENDING_BINDER_OVERDUE');

  // TAX-NOTICE-APPEAL-001 / TAX-CONTROL-STATUS-001: feste Tabellenfolge und
  // UUID-Sortierung verhindern zyklische Locks bei überlappenden Worker-Läufen.
  // Erst unter den gehaltenen Zeilenlocks werden Status, Frist und Empfänger
  // erneut gelesen; der Notification-Insert folgt in derselben Transaktion.
  if (noticeIds.length > 0) {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
          FROM public."tax_notice"
         WHERE "tenant_id" = ${tenantId}::uuid
           AND "id" IN (${Prisma.join(noticeIds.map((id) => Prisma.sql`${id}::uuid`))})
         ORDER BY "id"
         FOR UPDATE
      `,
    );
  }
  if (reminderIds.length > 0) {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
          FROM public."client_reminder"
         WHERE "tenant_id" = ${tenantId}::uuid
           AND "id" IN (${Prisma.join(reminderIds.map((id) => Prisma.sql`${id}::uuid`))})
         ORDER BY "id"
         FOR UPDATE
      `,
    );
  }
  if (binderIds.length > 0) {
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
          FROM public."pending_binder"
         WHERE "tenant_id" = ${tenantId}::uuid
           AND "id" IN (${Prisma.join(binderIds.map((id) => Prisma.sql`${id}::uuid`))})
         ORDER BY "id"
         FOR UPDATE
      `,
    );
  }
}

async function createDailyNotifications(
  tenantId: string,
  now: Date,
  groups: DailyNotification[][],
): Promise<number[]> {
  const candidatesBeforeAccessCheck = groups.flat();
  if (candidatesBeforeAccessCheck.length === 0) return groups.map(() => 0);

  // Der Daily-Dedupe-Index bucketisiert created_at in UTC-Tage. Mit exakt
  // demselben Fenster eliminiert die Vorab-Abfrage bekannte Keys als Set;
  // createMany(skipDuplicates) bleibt der Race-Backstop.
  const createdAtGte = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const createdAtLt = new Date(createdAtGte.getTime() + DAY_MS);

  return withWorkerTenantContext(tenantId, async (tx) => {
    await lockDailyNotificationSourcesTx(tx, tenantId, groups);
    const noticeResolvedGroups = await resolveTaxNoticeDeadlineRecipientsTx(tx, tenantId, groups);
    const reminderResolvedGroups = await resolveCurrentReminderRecipientsTx(
      tx,
      tenantId,
      noticeResolvedGroups,
    );
    const resolvedGroups = await filterCurrentBinderCandidatesTx(
      tx,
      tenantId,
      reminderResolvedGroups,
    );
    const filteredGroups = await filterCurrentRecipientsTx(tx, tenantId, resolvedGroups);
    const candidates = filteredGroups.flat();
    if (candidates.length === 0) return groups.map(() => 0);

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

    for (const group of filteredGroups) {
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
            clientId: candidate.clientId ?? null,
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

/**
 * TAX-CONTROL-STATUS-001: Abschluss, Faelligkeit und Zuweisung einer
 * Wiedervorlage koennen sich nach dem Owner-Read aendern. Der Insert-Tx liest
 * deshalb den aktuellen Quellvorgang und ersetzt veraltete Empfaenger durch
 * die jetzige Zuweisung. Nicht mehr offene oder verschobene Eintraege fallen
 * fail-closed heraus.
 */
async function resolveCurrentReminderRecipientsTx(
  tx: TxClient,
  tenantId: string,
  groups: DailyNotification[][],
): Promise<DailyNotification[][]> {
  const candidates = groups
    .flat()
    .filter((candidate) => candidate.recipientPolicy === 'CLIENT_REMINDER_DUE');
  if (candidates.length === 0) return groups;

  const deadlineTimestamps = [
    ...new Set(
      candidates
        .map((candidate) => candidate.deadlineAt?.getTime())
        .filter((value): value is number => value !== undefined),
    ),
  ];
  const currentReminders = await tx.clientReminder.findMany({
    where: {
      id: { in: [...new Set(candidates.map((candidate) => candidate.resourceId))] },
      tenantId,
      doneAt: null,
      dueDate: { in: deadlineTimestamps.map((timestamp) => new Date(timestamp)) },
      OR: [{ clientId: null }, { client: { mandateEndedAt: null } }],
    },
    select: {
      id: true,
      clientId: true,
      dueDate: true,
      createdByStaff: true,
      assignees: { select: { staffId: true } },
    },
  });
  const currentById = new Map(currentReminders.map((reminder) => [reminder.id, reminder]));

  return groups.map((group) =>
    group.flatMap((candidate) => {
      if (candidate.recipientPolicy !== 'CLIENT_REMINDER_DUE') return [candidate];
      const current = currentById.get(candidate.resourceId);
      if (
        !current ||
        current.clientId !== (candidate.clientId ?? null) ||
        !candidate.deadlineAt ||
        current.dueDate.getTime() !== candidate.deadlineAt.getTime()
      ) {
        return [];
      }
      const recipients = [
        ...new Set(
          current.assignees.length > 0
            ? current.assignees.map((assignee) => assignee.staffId)
            : [current.createdByStaff],
        ),
      ];
      return recipients.map((staffId) => ({ ...candidate, staffId }));
    }),
  );
}

/**
 * TAX-CONTROL-STATUS-001: Auch der Pendelordner muss unmittelbar vor dem
 * Insert noch beim Mandanten, ueberfaellig und im Status WITH_CLIENT sein.
 * Der aktuelle Ersteller wird danach durch die gemeinsame Zugriffskontrolle
 * auf Aktivitaet und Mandantenzugriff geprueft.
 */
async function filterCurrentBinderCandidatesTx(
  tx: TxClient,
  tenantId: string,
  groups: DailyNotification[][],
): Promise<DailyNotification[][]> {
  const candidates = groups
    .flat()
    .filter((candidate) => candidate.recipientPolicy === 'PENDING_BINDER_OVERDUE');
  if (candidates.length === 0) return groups;

  const deadlineTimestamps = [
    ...new Set(
      candidates
        .map((candidate) => candidate.deadlineAt?.getTime())
        .filter((value): value is number => value !== undefined),
    ),
  ];
  const currentBinders = await tx.pendingBinder.findMany({
    where: {
      id: { in: [...new Set(candidates.map((candidate) => candidate.resourceId))] },
      tenantId,
      client: { mandateEndedAt: null },
      status: 'WITH_CLIENT',
      expectedReturnAt: { in: deadlineTimestamps.map((timestamp) => new Date(timestamp)) },
    },
    select: {
      id: true,
      clientId: true,
      createdByStaff: true,
      expectedReturnAt: true,
    },
  });
  const currentById = new Map(currentBinders.map((binder) => [binder.id, binder]));

  return groups.map((group) =>
    group.flatMap((candidate) => {
      if (candidate.recipientPolicy !== 'PENDING_BINDER_OVERDUE') return [candidate];
      const current = currentById.get(candidate.resourceId);
      if (
        !current ||
        !candidate.clientId ||
        current.clientId !== candidate.clientId ||
        !candidate.deadlineAt ||
        !current.expectedReturnAt ||
        current.expectedReturnAt.getTime() !== candidate.deadlineAt.getTime()
      ) {
        return [];
      }
      return [{ ...candidate, staffId: current.createdByStaff }];
    }),
  );
}

/**
 * TAX-NOTICE-APPEAL-001 / TAX-CONTROL-STATUS-001:
 *
 * Ein TaxNotice-Reminder darf weder eine globale Notification (`staffId =
 * null`) erzeugen noch einen veralteten Empfaenger verwenden. Der aktuelle
 * Frist- und Zugriffsstand wird deshalb in derselben Tenant-Transaktion wie
 * der Insert erneut gelesen. Prioritaet: weiterhin berechtigter dokumentierter
 * Pruefer, aktive Hauptbearbeiter, aktive ADMIN/PARTNER. Gibt es kein aktuelles
 * Ziel, wird fail-closed keine Notification angelegt.
 */
async function resolveTaxNoticeDeadlineRecipientsTx(
  tx: TxClient,
  tenantId: string,
  groups: DailyNotification[][],
): Promise<DailyNotification[][]> {
  const candidates = groups
    .flat()
    .filter((candidate) => candidate.recipientPolicy === 'TAX_NOTICE_DEADLINE');
  if (candidates.length === 0) return groups;

  const noticeIds = [...new Set(candidates.map((candidate) => candidate.resourceId))];
  const deadlineTimestamps = [
    ...new Set(
      candidates
        .map((candidate) => candidate.deadlineAt?.getTime())
        .filter((value): value is number => value !== undefined),
    ),
  ];
  if (deadlineTimestamps.length === 0) {
    return groups.map((group) =>
      group.filter((candidate) => candidate.recipientPolicy !== 'TAX_NOTICE_DEADLINE'),
    );
  }

  const currentNotices = await tx.taxNotice.findMany({
    where: {
      id: { in: noticeIds },
      tenantId,
      client: { mandateEndedAt: null },
      appealDeadline: { in: deadlineTimestamps.map((timestamp) => new Date(timestamp)) },
      appealFiledAt: null,
      deadlineCalculationStatus: 'CALCULATED',
      manualReviewRequired: false,
      status: { notIn: [...CLOSED_APPEAL_NOTICE_STATUSES] },
    },
    select: {
      id: true,
      clientId: true,
      reviewedBy: true,
      appealDeadline: true,
      deadlineCalculationStatus: true,
      manualReviewRequired: true,
    },
  });
  const currentById = new Map(currentNotices.map((notice) => [notice.id, notice]));

  const validCurrent = candidates.flatMap((candidate) => {
    const current = currentById.get(candidate.resourceId);
    if (
      !current ||
      !candidate.clientId ||
      current.clientId !== candidate.clientId ||
      !candidate.deadlineAt ||
      !current.appealDeadline ||
      current.appealDeadline.getTime() !== candidate.deadlineAt.getTime() ||
      current.deadlineCalculationStatus !== 'CALCULATED' ||
      current.manualReviewRequired
    ) {
      return [];
    }
    return [{ candidate, current }];
  });

  const preferredByClient = new Map<string, Set<string>>();
  for (const { current } of validCurrent) {
    if (!current.reviewedBy) continue;
    const ids = preferredByClient.get(current.clientId) ?? new Set<string>();
    ids.add(current.reviewedBy);
    preferredByClient.set(current.clientId, ids);
  }
  const allowedPreferredByClient = new Map<string, Set<string>>();
  for (const [clientId, staffIds] of preferredByClient) {
    allowedPreferredByClient.set(
      clientId,
      await filterStaffAccessClientTx(tx, tenantId, [...staffIds], clientId),
    );
  }

  const fallbackClientIds = [
    ...new Set(
      validCurrent
        .filter(
          ({ current }) =>
            !current.reviewedBy ||
            !(allowedPreferredByClient.get(current.clientId)?.has(current.reviewedBy) ?? false),
        )
        .map(({ current }) => current.clientId),
    ),
  ];

  const hauptbearbeiterByClient = new Map<string, string[]>();
  if (fallbackClientIds.length > 0) {
    const responsibilities = await tx.clientResponsibility.findMany({
      where: {
        tenantId,
        clientId: { in: fallbackClientIds },
        role: 'HAUPTBEARBEITER',
        staff: { tenantId, active: true },
      },
      select: { clientId: true, staffId: true },
    });
    for (const responsibility of responsibilities) {
      const ids = hauptbearbeiterByClient.get(responsibility.clientId) ?? [];
      ids.push(responsibility.staffId);
      hauptbearbeiterByClient.set(responsibility.clientId, ids);
    }
    for (const clientId of fallbackClientIds) {
      const ids = [...new Set(hauptbearbeiterByClient.get(clientId) ?? [])];
      const allowed = await filterStaffAccessClientTx(tx, tenantId, ids, clientId);
      hauptbearbeiterByClient.set(
        clientId,
        ids.filter((staffId) => allowed.has(staffId)),
      );
    }
  }

  const adminFallbackClientIds = fallbackClientIds.filter(
    (clientId) => (hauptbearbeiterByClient.get(clientId)?.length ?? 0) === 0,
  );
  const adminsByClient = new Map<string, string[]>();
  if (adminFallbackClientIds.length > 0) {
    const activeAdminPartners = await tx.staffUser.findMany({
      where: {
        tenantId,
        active: true,
        roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
      },
      select: { id: true },
    });
    const adminPartnerIds = [...new Set(activeAdminPartners.map((staff) => staff.id))];
    for (const clientId of adminFallbackClientIds) {
      const allowed = await filterStaffAccessClientTx(tx, tenantId, adminPartnerIds, clientId);
      adminsByClient.set(
        clientId,
        adminPartnerIds.filter((staffId) => allowed.has(staffId)),
      );
    }
  }

  return groups.map((group) =>
    group.flatMap((candidate) => {
      if (candidate.recipientPolicy !== 'TAX_NOTICE_DEADLINE') return [candidate];
      const current = currentById.get(candidate.resourceId);
      if (
        !current ||
        !candidate.clientId ||
        current.clientId !== candidate.clientId ||
        !candidate.deadlineAt ||
        !current.appealDeadline ||
        current.appealDeadline.getTime() !== candidate.deadlineAt.getTime() ||
        current.deadlineCalculationStatus !== 'CALCULATED' ||
        current.manualReviewRequired
      ) {
        return [];
      }

      const preferredAllowed =
        current.reviewedBy &&
        (allowedPreferredByClient.get(current.clientId)?.has(current.reviewedBy) ?? false);
      const hauptbearbeiter = hauptbearbeiterByClient.get(current.clientId) ?? [];
      const recipients = preferredAllowed
        ? [current.reviewedBy!]
        : hauptbearbeiter.length > 0
          ? hauptbearbeiter
          : (adminsByClient.get(current.clientId) ?? []);
      return recipients.map((staffId) => ({ ...candidate, staffId }));
    }),
  );
}

/**
 * Eine Zuweisung kann aus einer frueheren OPEN-Phase stammen. Fuer jeden
 * mandantenbezogenen Kandidaten wird deshalb innerhalb derselben Tenant-Tx
 * wie der Notification-Insert die aktuelle Policy erneut ausgewertet. Bei
 * internen Wiedervorlagen ohne Mandant wird wenigstens die aktive
 * Tenant-Zugehoerigkeit des aktuellen Empfaengers verlangt.
 */
async function filterCurrentRecipientsTx(
  tx: TxClient,
  tenantId: string,
  groups: DailyNotification[][],
): Promise<DailyNotification[][]> {
  const candidatesByClient = new Map<string, Set<string>>();
  const internalStaffIds = new Set<string>();
  for (const candidate of groups.flat()) {
    if (!candidate.staffId) continue;
    if (candidate.clientId === null) {
      internalStaffIds.add(candidate.staffId);
      continue;
    }
    if (!candidate.clientId) continue;
    const ids = candidatesByClient.get(candidate.clientId) ?? new Set<string>();
    ids.add(candidate.staffId);
    candidatesByClient.set(candidate.clientId, ids);
  }

  const allowedByClient = new Map<string, Set<string>>();
  for (const [clientId, staffIds] of candidatesByClient) {
    allowedByClient.set(
      clientId,
      await filterStaffAccessClientTx(tx, tenantId, [...staffIds], clientId),
    );
  }
  const activeInternalStaff = new Set(
    internalStaffIds.size === 0
      ? []
      : (
          await tx.staffUser.findMany({
            where: { id: { in: [...internalStaffIds] }, tenantId, active: true },
            select: { id: true },
          })
        ).map((staff) => staff.id),
  );

  return groups.map((group) =>
    group.filter(
      (candidate) =>
        candidate.clientId === undefined ||
        (candidate.staffId !== null &&
          (candidate.clientId === null
            ? activeInternalStaff.has(candidate.staffId)
            : (allowedByClient.get(candidate.clientId)?.has(candidate.staffId) ?? false))),
    ),
  );
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
      const modules = await readWorkerTenantModules(tenantId);
      const [notices, reminders, binders] = await Promise.all([
        // Exakt die drei relevanten @db.Date-Tage statt aller künftigen
        // Bescheide zu laden und anschließend im Worker zu filtern.
        modules.taxNotices
          ? prismaOwner.taxNotice.findMany({
              where: {
                tenantId,
                client: { mandateEndedAt: null },
                appealDeadline: { in: appealDates },
                appealFiledAt: null,
                deadlineCalculationStatus: 'CALCULATED',
                manualReviewRequired: false,
                status: { notIn: [...CLOSED_APPEAL_NOTICE_STATUSES] },
              },
              select: {
                id: true,
                kind: true,
                period: true,
                appealDeadline: true,
                client: { select: { id: true, name: true } },
                reviewedBy: true,
                deadlineCalculationStatus: true,
                manualReviewRequired: true,
              },
            })
          : Promise.resolve([]),
        modules.reminders
          ? prismaOwner.clientReminder.findMany({
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
            })
          : Promise.resolve([]),
        modules.binders
          ? prismaOwner.pendingBinder.findMany({
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
            })
          : Promise.resolve([]),
      ]);

      const appealNotifications: DailyNotification[] = [];
      for (const n of notices) {
        if (
          !n.appealDeadline ||
          n.deadlineCalculationStatus !== 'CALCULATED' ||
          n.manualReviewRequired
        ) {
          continue;
        }
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
          clientId: n.client.id,
          recipientPolicy: 'TAX_NOTICE_DEADLINE',
          deadlineAt: n.appealDeadline,
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
          clientId: reminder.client?.id ?? null,
          recipientPolicy: 'CLIENT_REMINDER_DUE' as const,
          deadlineAt: reminder.dueDate,
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
          clientId: binder.client.id,
          recipientPolicy: 'PENDING_BINDER_OVERDUE',
          deadlineAt: binder.expectedReturnAt,
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
