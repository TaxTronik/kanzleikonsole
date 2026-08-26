// =============================================================================
// Verzögerte „Wiedervorlage erledigt"-Benachrichtigung an die delegierende Person.
//
// Warum verzögert: Die Checkbox erledigt mit EINEM Klick. Ein Fehlgriff soll
// folgenlos zurücknehmbar sein — eine bereits zugestellte Benachrichtigung
// lässt sich aber nicht mehr einfangen. Deshalb wartet die Zustellung
// `REMINDER_DONE_NOTIFY_DELAY_MS`; ein „Rückgängig" in diesem Fenster entfernt
// den Job, und es geht gar nichts raus.
//
// Die Queue kommt aus dem zentralen Web-BullMQ-Registry.
// =============================================================================

import { JOB_QUEUES, type ReminderDoneNotifyJob } from '@taxtronik/config/job-queues';
import { withTimeout } from '@/lib/with-timeout';
import { log } from '@/server/logger';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from './bullmq';

/**
 * Rücknahme-Fenster. Wird auch von der UI für den Countdown des
 * „Rückgängig"-Balkens gelesen — eine Quelle, damit beide nicht auseinanderlaufen.
 */
export const REMINDER_DONE_NOTIFY_DELAY_MS = 10_000;

export type { ReminderDoneNotifyJob } from '@taxtronik/config/job-queues';

/** Job-ID pro Wiedervorlage — ein erneutes Erledigen ersetzt den alten Job. */
function jobIdFor(reminderId: string): string {
  return `reminder-done-${reminderId}`;
}

/**
 * Plant die Benachrichtigung ein. Rückgabe `false`, wenn Redis nicht erreichbar
 * war — dann muss der Aufrufer sofort benachrichtigen, statt die Rückmeldung
 * still zu verlieren (die delegierende Person wartet darauf).
 */
export async function scheduleReminderDoneNotification(
  job: ReminderDoneNotifyJob,
): Promise<boolean> {
  try {
    const queue = getWebQueue(JOB_QUEUES.reminderDoneNotify.name);
    const jobId = jobIdFor(job.reminderId);
    await withTimeout(queue.remove(jobId), WEB_QUEUE_TIMEOUT_MS).catch(() => {});
    await withTimeout(
      queue.add('notify', job, {
        jobId,
        delay: REMINDER_DONE_NOTIFY_DELAY_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      }),
      WEB_QUEUE_TIMEOUT_MS,
    );
    return true;
  } catch (err) {
    log.warn(
      { component: 'reminder-done-queue', reminderId: job.reminderId, err: String(err) },
      'Verzögerte Erledigt-Benachrichtigung konnte nicht eingeplant werden',
    );
    return false;
  }
}

/**
 * Nimmt eine eingeplante Benachrichtigung zurück (Rückgängig im Zeitfenster).
 * Best-effort: läuft der Job gerade, schlägt `remove` fehl — dann ist die
 * Benachrichtigung bereits draussen und das Zurückholen bleibt trotzdem gültig.
 */
export async function cancelReminderDoneNotification(reminderId: string): Promise<void> {
  try {
    const queue = getWebQueue(JOB_QUEUES.reminderDoneNotify.name);
    await withTimeout(queue.remove(jobIdFor(reminderId)), WEB_QUEUE_TIMEOUT_MS);
  } catch {
    /* best-effort */
  }
}
