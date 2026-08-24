// =============================================================================
// tax-deadline-materialize-Worker
//
// Täglicher Regelbetrieb der Steuertermin-Materialisierung. Die eigentliche
// Logik lebt in @taxtronik/tax (materializeTenantTaxDeadlines) und ist mit
// dem Web-Pfad (apps/web/src/server/tax-deadlines/materialize.ts) geteilt —
// EINE Logik, keine Drift. Hier nur die Worker-Verdrahtung:
//   - prismaOwner (BYPASSRLS) als DB-Client; tenantId-Filter setzt der Kern;
//   - atomare Blöcke (Request + Deadline-Update + Audit-Eintrag) laufen je in
//     einer withWorkerTenantContext-Transaktion (Muster: invoice-overdue);
//   - Audit über EvidenceService (Muster: risk-analyse-llm).
//
// Mandant muss freigeschaltet (allowActive) sein — sonst keine Termine.
// =============================================================================

import { Worker } from 'bullmq';
import { EvidenceService, LocalTimestampAdapter } from '@taxtronik/evidence';
import { resolveNotificationsTx, upsertNotificationTx } from '@taxtronik/db/notification';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { materializeTenantTaxDeadlines } from '@taxtronik/tax';
import { notifyAutomaticTaxRequestOpened } from '../mail';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { isWorkerTenantModuleEnabled } from '../module-gate';
import { processTaxDeadlineNotifications } from './tax-deadline-notification';

const HORIZON_DAYS = 90;

// record() braucht nur den Tx (der TimestampPort dient dem Versiegeln, nicht
// dem Schreiben) — Muster wie in risk-analyse-llm.ts.
const evidence = new EvidenceService(new LocalTimestampAdapter());

export const taxDeadlineMaterializeWorker = new Worker<ChecksJob>(
  'tax-deadline-materialize',
  async (job) => {
    const tenantIds = job.data.tenantId
      ? [job.data.tenantId]
      : (await prismaOwner.tenant.findMany({ select: { id: true } })).map((t) => t.id);

    let totalCreated = 0;
    let totalRequests = 0;
    let totalOverdue = 0;
    let totalWarned = 0;
    let totalMailRecipients = 0;
    let totalNotificationAttempts = 0;
    let totalProviderAccepted = 0;
    let totalNotificationEscalated = 0;
    let totalNotificationRetries = 0;

    for (const tenantId of tenantIds) {
      if (!(await isWorkerTenantModuleEnabled(tenantId, 'taxNotices'))) {
        log.info({ tenantId }, 'tax-deadline: Modul deaktiviert, skip');
        continue;
      }
      // System-Staff fuer createdByStaff neuer Auto-Anforderungen. Bereits
      // persistierte Benachrichtigungen werden auch ohne diesen Account noch
      // abgearbeitet; sie gehoeren zu einem schon existierenden Request.
      const systemStaff = await prismaOwner.staffUser.findFirst({
        where: {
          tenantId,
          active: true,
          roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
        },
        select: { id: true },
      });
      if (systemStaff) {
        const stats = await materializeTenantTaxDeadlines(
          {
            db: prismaOwner,
            runAtomic: (fn) => withWorkerTenantContext(tenantId, fn),
            recordEvidence: (tx, event) => evidence.record(tx, event),
            // Läuft in derselben withWorkerTenantContext-Tx wie staffNotifiedAt.
            upsertStaffNotification: (tx, input) => upsertNotificationTx(tx, input),
            resolveStaffNotifications: (tx, input) =>
              resolveNotificationsTx(tx, {
                tenantId: input.tenantId,
                resources: [{ resourceType: input.resourceType, resourceId: input.resourceId }],
              }),
          },
          { tenantId, systemStaffId: systemStaff.id, horizonDays: HORIZON_DAYS },
        );
        totalCreated += stats.deadlinesCreated;
        totalRequests += stats.requestsCreated;
        totalOverdue += stats.markedOverdue;
        totalWarned += stats.staffWarned;
      } else {
        log.info(
          { tenantId },
          'tax-deadline: kein ADMIN/PARTNER, nur bestehende Benachrichtigungen',
        );
      }

      // TAX-DEADLINE-AUTOREQUEST-001: Nicht nur die in DIESEM Lauf neu
      // erzeugten Requests bearbeiten, sondern auch persistierte QUEUED- und
      // eindeutig FAILED-Zustaende. So bleibt die requestId stabil und ein
      // Worker-/SMTP-Fehler kann keine zweite fachliche Anforderung erzeugen.
      const notificationStats = await processTaxDeadlineNotifications(
        {
          db: prismaOwner,
          runAtomic: (fn) => withWorkerTenantContext(tenantId, fn),
          notifyAutomaticTaxRequestOpened,
          upsertStaffNotification: (tx, input) => upsertNotificationTx(tx, input),
          resolveFailureNotifications: (tx, input) =>
            resolveNotificationsTx(tx, {
              tenantId: input.tenantId,
              resources: [{ resourceType: 'tax_deadline', resourceId: input.deadlineId }],
              kinds: ['TAX_DEADLINE_NOTIFICATION_FAILED'],
            }),
          logUncertainError: ({ deadlineId, requestId, error }) => {
            log.error(
              { tenantId, deadlineId, requestId, err: (error as Error).message },
              'tax-deadline: Benachrichtigungsstatus unklar',
            );
          },
        },
        { tenantId },
      );
      totalNotificationAttempts += notificationStats.processed;
      totalProviderAccepted += notificationStats.providerAccepted;
      totalMailRecipients += notificationStats.recipientsAccepted;
      totalNotificationEscalated += notificationStats.escalated;
      totalNotificationRetries += notificationStats.retryPending;
    }

    log.info(
      {
        created: totalCreated,
        requests: totalRequests,
        overdue: totalOverdue,
        warned: totalWarned,
        mailRecipients: totalMailRecipients,
        notificationAttempts: totalNotificationAttempts,
        providerAccepted: totalProviderAccepted,
        notificationEscalated: totalNotificationEscalated,
        notificationRetries: totalNotificationRetries,
      },
      'tax-deadline-materialize: done',
    );
    // Ein eindeutig fehlgeschlagener Versuch darf BullMQ erneut ausfuehren.
    // Der persistierte FAILED-Zustand + CAS verhindert Doppelversand; UNKNOWN,
    // Teilfehler und fehlende Empfaenger werden dagegen bewusst nicht retried.
    if (totalNotificationRetries > 0) {
      throw new Error(
        `${totalNotificationRetries} Auto-Anforderungs-Benachrichtigung(en) warten auf Retry`,
      );
    }
    return {
      created: totalCreated,
      requests: totalRequests,
      overdue: totalOverdue,
      warned: totalWarned,
      mailRecipients: totalMailRecipients,
    };
  },
  { connection, concurrency: 1 },
);

taxDeadlineMaterializeWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'tax-deadline-materialize: failed');
});
