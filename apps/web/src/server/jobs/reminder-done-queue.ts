// =============================================================================
// Verzögerte „Wiedervorlage erledigt"-Benachrichtigung an die delegierende Person.
//
// Warum verzögert: Die Checkbox erledigt mit EINEM Klick. Ein Fehlgriff soll
// folgenlos zurücknehmbar sein — eine bereits zugestellte Benachrichtigung
// lässt sich aber nicht mehr einfangen. Deshalb wartet die Zustellung
// `REMINDER_DONE_NOTIFY_DELAY_MS`; ein „Rückgängig" in diesem Fenster entfernt
// den Job, und es geht gar nichts raus.
//
// Singleton-Muster wie risk-analyse-queue.ts (eine IORedis-Connection pro
// Prozess, im globalThis gecacht).
// =============================================================================

import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';
import { withTimeout } from '@/lib/with-timeout';

const QUEUE_TIMEOUT_MS = 2_000;

/**
 * Rücknahme-Fenster. Wird auch von der UI für den Countdown des
 * „Rückgängig"-Balkens gelesen — eine Quelle, damit beide nicht auseinanderlaufen.
 */
export const REMINDER_DONE_NOTIFY_DELAY_MS = 10_000;

export interface ReminderDoneNotifyJob {
  tenantId: string;
  reminderId: string;
  /** Empfänger = die delegierende Person. */
  staffId: string;
  clientId: string;
  subject: string;
  /** Wer erledigt hat — für den Benachrichtigungstext. */
  doneByName: string;
}

declare global {
  // `var` is intentional for ambient globalThis augmentation.
  // noinspection ES6ConvertVarToLetConst
  var __taxtronik_reminder_done_queue:
    | { conn: IORedis; queue: Queue<ReminderDoneNotifyJob> }
    | undefined;
}

function getHandle(): { conn: IORedis; queue: Queue<ReminderDoneNotifyJob> } {
  const existing = globalThis.__taxtronik_reminder_done_queue;
  if (existing) return existing;

  const conn = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conn.on('error', (err) => {
    log.warn({ component: 'reminder-done-queue', err: err.message }, 'redis error');
  });
  const queue = new Queue<ReminderDoneNotifyJob>('reminder-done-notify', { connection: conn });
  const handle = { conn, queue };
  globalThis.__taxtronik_reminder_done_queue = handle;
  return handle;
}

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
    const { queue } = getHandle();
    const jobId = jobIdFor(job.reminderId);
    await withTimeout(queue.remove(jobId), QUEUE_TIMEOUT_MS).catch(() => {});
    await withTimeout(
      queue.add('notify', job, {
        jobId,
        delay: REMINDER_DONE_NOTIFY_DELAY_MS,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      }),
      QUEUE_TIMEOUT_MS,
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
    const { queue } = getHandle();
    await withTimeout(queue.remove(jobIdFor(reminderId)), QUEUE_TIMEOUT_MS);
  } catch {
    /* best-effort */
  }
}
