// =============================================================================
// Mail-Outbox der Web-App (Review-Befund F-08)
//
// Mandanten-Mails, die ein fachlicher Vorgang auslöst (neue Anforderung,
// GwG-Einladung, Terminentscheidung, Rechnungsversand, ...), werden NICHT mehr
// nach dem Commit direkt an SMTP gegeben. Die Action legt sie in DERSELBEN
// Transaktion als Versandauftrag ab (enqueue…MailTx) und stößt nach dem Commit
// den Worker an (kickMailOutboxDelivery). Der Worker stellt mit Retry/Backoff
// zu und benachrichtigt die Kanzlei bei endgültigem Fehlschlag; der Status ist
// am Vorgang sichtbar (server/mail/delivery-status.ts).
//
// Schlägt der Anstoß fehl (Redis nicht erreichbar), holt der Minutentakt des
// Workers den Auftrag nach — der Auftrag selbst ist bereits committet.
// =============================================================================

import { JOB_QUEUES, MAIL_OUTBOX_KICK_JOB_OPTIONS } from '@taxtronik/config/job-queues';
import { withTimeout } from '@/lib/with-timeout';
import { getWebQueue, WEB_QUEUE_TIMEOUT_MS } from '@/server/jobs/bullmq';
import { fireAndForget } from '@/server/util/fire-and-forget';

export {
  enqueueClientContactsMailTx,
  enqueueDirectMailTx,
  MAIL_OUTBOX_PURPOSE_LABELS,
  type MailOutboxPurpose,
  type MailOutboxResourceType,
  type MailOutboxTarget,
  type OutboxAttachmentRef,
  type OutboxContactMail,
  type OutboxDirectMail,
} from '@taxtronik/mail/outbox';

async function addKickJob(): Promise<void> {
  const queue = getWebQueue(JOB_QUEUES.mailOutboxDeliver.name);
  await withTimeout(
    queue.add('kick', {}, { ...MAIL_OUTBOX_KICK_JOB_OPTIONS }),
    WEB_QUEUE_TIMEOUT_MS,
  );
}

/**
 * Stößt die Zustellung nach dem Commit an, ohne die Antwort der Action zu
 * blockieren. Ein Fehler wird geloggt; der Minutentakt des Workers holt den
 * bereits committeten Auftrag nach.
 */
export function kickMailOutboxDelivery(): void {
  fireAndForget('mail-outbox-deliver kick', addKickJob());
}
