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
import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { upsertNotificationTx } from '@taxtronik/db/notification';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { connection, type ReminderDoneNotifyJob } from '../queues';
import { withWorkerTenantContext } from '../tenant-context';
import { log } from '../logger';
import { isWorkerTenantModuleEnabled } from '../module-gate';

export const reminderDoneNotifyWorker = new Worker<ReminderDoneNotifyJob>(
  JOB_QUEUES.reminderDoneNotify.name,
  async (job) => {
    const { tenantId, reminderId, staffId, doneByName } = job.data;

    if (!(await isWorkerTenantModuleEnabled(tenantId, 'reminders'))) {
      log.info(
        { component: 'reminder-done-notify', tenantId, reminderId },
        'Wiedervorlagen-Modul deaktiviert — Benachrichtigung entfällt',
      );
      return;
    }

    await withWorkerTenantContext(tenantId, async (tx) => {
      const reminder = await tx.clientReminder.findFirst({
        where: { id: reminderId, tenantId },
        select: { doneAt: true, clientId: true, subject: true },
      });
      // Zurückgeholt (oder gelöscht) → nichts zustellen.
      if (!reminder?.doneAt) {
        log.info(
          { component: 'reminder-done-notify', reminderId },
          'Wiedervorlage nicht mehr erledigt — Benachrichtigung entfällt',
        );
        return;
      }

      if (reminder.clientId) {
        const allowed = await filterStaffAccessClientTx(tx, tenantId, [staffId], reminder.clientId);
        if (!allowed.has(staffId)) {
          log.info(
            { component: 'reminder-done-notify', reminderId, staffId },
            'Empfaenger darf auf Mandanten nicht mehr zugreifen — Benachrichtigung entfaellt',
          );
          return;
        }
      }

      await upsertNotificationTx(tx, {
        tenantId,
        staffId,
        kind: 'CLIENT_REMINDER_DONE',
        title: `Wiedervorlage erledigt: ${reminder.subject}`,
        body: `${doneByName} hat die von dir delegierte Wiedervorlage abgeschlossen.`,
        href: reminder.clientId ? `/staff/clients/${reminder.clientId}` : '/staff/reminders',
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
