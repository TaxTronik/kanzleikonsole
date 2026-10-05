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
//
// S-06 (Folgearbeit): Der Job trägt nur { tenantId, reminderId, staffId }.
// Betreff, Mandant und den Namen der erledigenden Person liest der Worker beim
// Zustellen aus der Wiedervorlage. Jobs der Vorversion mit Betreff und Namen
// in Redis werden weiter angenommen; auch für sie gelten die DB-Werte.
// =============================================================================

import { createWorker } from '../worker-factory';
import { JOB_QUEUES, type LegacyReminderDoneNotifyJob } from '@taxtronik/config/job-queues';
import { filterStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { connection, type ReminderDoneNotifyJob } from '../queues';
import { withWorkerTenantContext } from '../tenant-context';
import { notify } from '../notify';
import { log } from '../logger';
import { isWorkerTenantModuleEnabled } from '../module-gate';

type QueuedReminderDoneNotifyJob = ReminderDoneNotifyJob | LegacyReminderDoneNotifyJob;

export const reminderDoneNotifyWorker = createWorker<QueuedReminderDoneNotifyJob, void, string>(
  JOB_QUEUES.reminderDoneNotify.name,
  async (job) => {
    const { tenantId, reminderId, staffId } = job.data;

    if (!(await isWorkerTenantModuleEnabled(tenantId, 'reminders'))) {
      log.info(
        { component: 'reminder-done-notify', tenantId, reminderId },
        'Wiedervorlagen-Modul deaktiviert — Benachrichtigung entfällt',
      );
      return;
    }

    await withWorkerTenantContext(tenantId, async (tx) => {
      // REMINDER-TICKET-001: same lock as archive/reopen; a queued job grants no write window.
      await tx.$queryRaw`SELECT id FROM client_reminder
        WHERE id = ${reminderId}::uuid AND tenant_id = ${tenantId}::uuid FOR NO KEY UPDATE`;
      const reminder = await tx.clientReminder.findFirst({
        where: { id: reminderId, tenantId },
        select: {
          doneAt: true,
          doneByStaff: true,
          clientId: true,
          subject: true,
          archivedAt: true,
        },
      });
      // Zurückgeholt (oder gelöscht) → nichts zustellen.
      if (!reminder?.doneAt || reminder.archivedAt) {
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

      const doneBy = reminder.doneByStaff
        ? await tx.staffUser.findFirst({
            where: { id: reminder.doneByStaff, tenantId },
            select: { fullName: true },
          })
        : null;
      await notify(tx, {
        tenantId,
        staffId,
        kind: 'CLIENT_REMINDER_DONE',
        title: `Wiedervorlage erledigt: ${reminder.subject}`,
        body: `${doneBy?.fullName ?? 'Ein Mitarbeiter'} hat die von dir delegierte Wiedervorlage abgeschlossen.`,
        href: reminder.clientId ? `/staff/clients/${reminder.clientId}` : '/staff/reminders',
        resourceType: 'client_reminder',
        resourceId: reminderId,
      });
    });
  },
  { connection, concurrency: 4 },
);
