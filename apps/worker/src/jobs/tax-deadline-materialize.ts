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
import { upsertNotificationTx } from '@taxtronik/db/notification';
import { connection, type ChecksJob } from '../queues';
import { log } from '../logger';
import { materializeTenantTaxDeadlines } from '@taxtronik/tax';
import { notifyRequestOpened } from '../mail';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';

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

    for (const tenantId of tenantIds) {
      // System-Staff für createdByStaff der Auto-Anforderungen — wir nehmen
      // den ersten ADMIN/PARTNER. Ohne so einen Account: skip.
      const systemStaff = await prismaOwner.staffUser.findFirst({
        where: {
          tenantId,
          active: true,
          roles: { some: { role: { in: ['ADMIN', 'PARTNER'] } } },
        },
        select: { id: true },
      });
      if (!systemStaff) {
        log.info({ tenantId }, 'tax-deadline: kein ADMIN/PARTNER, skip');
        continue;
      }

      const stats = await materializeTenantTaxDeadlines(
        {
          db: prismaOwner,
          runAtomic: (fn) => withWorkerTenantContext(tenantId, fn),
          recordEvidence: (tx, event) => evidence.record(tx, event),
          // Läuft in derselben withWorkerTenantContext-Tx wie staffNotifiedAt.
          upsertStaffNotification: (tx, input) => upsertNotificationTx(tx, input),
        },
        { tenantId, systemStaffId: systemStaff.id, horizonDays: HORIZON_DAYS },
      );
      totalCreated += stats.deadlinesCreated;
      totalRequests += stats.requestsCreated;
      totalOverdue += stats.markedOverdue;
      totalWarned += stats.staffWarned;

      // Mandanten-Mail (request-opened, Parität zum manuellen Anlegen) + n8n-
      // Event NACH dem Commit der Request-Anlage. Fehler failen den Job NICHT:
      // der Termin ist bereits REMINDED — ein BullMQ-Retry würde keine Mails
      // nachholen, aber die restlichen Tenants blockieren. (Gleiche Semantik
      // wie fireAndForget im manuellen Web-Pfad.)
      for (const r of stats.createdRequests) {
        try {
          const res = await notifyRequestOpened({
            tenantId: r.tenantId,
            clientId: r.clientId,
            requestId: r.requestId,
            title: r.title,
            description: r.description,
            priority: r.priority,
            dueAtIso: r.dueDate.toISOString(),
          });
          totalMailRecipients += res.recipients;
        } catch (e) {
          log.error(
            { tenantId, requestId: r.requestId, err: (e as Error).message },
            'tax-deadline: request-opened-Versand fehlgeschlagen',
          );
        }
      }
    }

    log.info(
      {
        created: totalCreated,
        requests: totalRequests,
        overdue: totalOverdue,
        warned: totalWarned,
        mailRecipients: totalMailRecipients,
      },
      'tax-deadline-materialize: done',
    );
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
