// =============================================================================
// Verzögerte „Wiedervorlage erledigt"-Benachrichtigung.
//
// Gegenstück zu server/jobs/reminder-done-queue.ts im Web: der Job wird beim
// Erledigen mit ~10 s Verzögerung eingereiht, damit ein „Rückgängig" ihn noch
// entfernen kann. Läuft er, ist das Rücknahme-Fenster abgelaufen.
//
// Vor dem Zustellen wird der Ist-Zustand nachgeprüft: Kam das Zurückholen
// durch, während der Job schon gesperrt war (oder war Redis kurz weg und der
// Job überlebte den Undo), darf keine Benachrichtigung rausgehen. Die
// Datenbank ist die Wahrheit, nicht der Job.
// =============================================================================

import { Worker } from 'bullmq';
import { upsertNotificationTx } from '@taxtronik/db/notification';
import { connection, type ReminderDoneNotifyJob } from '../queues';
import { withWorkerTenantContext } from '../tenant-context';
import { log } from '../logger';

export const reminderDoneNotifyWorker = new Worker<ReminderDoneNotifyJob>(
  'reminder-done-notify',
  async (job) => {
    const { tenantId, reminderId, staffId, clientId, subject, doneByName } = job.data;

    await withWorkerTenantContext(tenantId, async (tx) => {
      const reminder = await tx.clientReminder.findUnique({
        where: { id: reminderId },
        select: { doneAt: true },
      });
      // Zurückgeholt (oder gelöscht) → nichts zustellen.
      if (!reminder?.doneAt) {
        log.info(
          { component: 'reminder-done-notify', reminderId },
          'Wiedervorlage nicht mehr erledigt — Benachrichtigung entfällt',
        );
        return;
      }

      await upsertNotificationTx(tx, {
        tenantId,
        staffId,
        kind: 'CLIENT_REMINDER_DONE',
        title: `Wiedervorlage erledigt: ${subject}`,
        body: `${doneByName} hat die von dir delegierte Wiedervorlage abgeschlossen.`,
        href: `/staff/clients/${clientId}`,
        resourceType: 'client_reminder',
        resourceId: reminderId,
      });
    });
  },
  { connection, concurrency: 4 },
);

reminderDoneNotifyWorker.on('failed', (job, err) => {
  log.error(
    { component: 'reminder-done-notify', jobId: job?.id, err: err.message },
    'Erledigt-Benachrichtigung fehlgeschlagen',
  );
});
