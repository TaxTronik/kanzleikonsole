// =============================================================================
// mail-outbox-deliver — Worker-Verdrahtung der Mail-Outbox (Review-Befund F-08)
//
// Der Zustandsautomat lebt in ./mail-outbox.ts (abhängigkeitsfrei testbar).
// Hier: Owner-Client für den mandantenübergreifenden Scan, Tenant-
// Transaktionen für Statuswechsel und Kanzlei-Hinweis, Versand über die
// Worker-Adapter von @taxtronik/mail (registrieren Logger und n8n-Emitter) und
// Anhänge aus der gebundenen, SHA-256-geprüften Dokumentfassung.
//
// S-01: Bleibt beim Owner-Client: Die App-Rolle darf mail_outbox bewusst nur
// anlegen und lesen; Claims und Statuswechsel des Zustandsautomaten über alle
// Tenants gehören dem Worker.
// =============================================================================

import { JOB_QUEUES } from '@taxtronik/config/job-queues';
import { fetchVerifiedObjectBytes } from '@taxtronik/storage';
import type { MailAttachment } from '@taxtronik/mail';
import type { OutboxAttachmentRef } from '@taxtronik/mail/outbox';
import { createWorker } from '../worker-factory';
import { connection } from '../queues';
import { log } from '../logger';
import { notifyClientContacts, sendTemplateMail } from '../mail';
import { notify } from '../notify';
import { prismaOwner } from '../prisma-owner';
import { withWorkerTenantContext } from '../tenant-context';
import { processMailOutbox, type MailOutboxDeliveryDeps } from './mail-outbox';

/** Höchstens so viele volle Batches je Lauf; der nächste Lauf setzt fort. */
const MAX_BATCHES_PER_RUN = 8;
const BATCH_SIZE = 25;

/** Lädt einen Anhang aus genau der beim Auftrag gebundenen Dokumentfassung. */
async function loadDocumentVersionAttachment(input: {
  tenantId: string;
  ref: OutboxAttachmentRef;
}): Promise<MailAttachment> {
  const version = await prismaOwner.documentVersion.findFirst({
    where: {
      id: input.ref.documentVersionId,
      document: { tenantId: input.tenantId, deletedAt: null },
    },
    select: {
      storageBucket: true,
      storageKey: true,
      storageVersionId: true,
      sha256: true,
      sizeBytes: true,
    },
  });
  if (!version) throw new Error('Anhang des Versandauftrags nicht gefunden.');
  const content = await fetchVerifiedObjectBytes(
    { bucket: version.storageBucket, key: version.storageKey, versionId: version.storageVersionId },
    { sizeBytes: version.sizeBytes, sha256: version.sha256 },
  );
  return {
    filename: input.ref.filename,
    content,
    ...(input.ref.contentType ? { contentType: input.ref.contentType } : {}),
  };
}

export function mailOutboxDeliveryDeps(): MailOutboxDeliveryDeps {
  return {
    db: prismaOwner,
    runAtomic: (tenantId, fn) => withWorkerTenantContext(tenantId, fn),
    sendTemplateMail,
    notifyClientContacts,
    loadAttachment: loadDocumentVersionAttachment,
    notifyStaff: (tx, input) => notify(tx, input),
    log,
  };
}

export const mailOutboxDeliverWorker = createWorker(
  JOB_QUEUES.mailOutboxDeliver.name,
  async () => {
    const deps = mailOutboxDeliveryDeps();
    const totals = {
      processed: 0,
      providerAccepted: 0,
      retryPending: 0,
      noRecipient: 0,
      escalated: 0,
      skipped: 0,
      resendContentCleared: 0,
    };
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const stats = await processMailOutbox(deps, { batchSize: BATCH_SIZE });
      totals.processed += stats.processed;
      totals.providerAccepted += stats.providerAccepted;
      totals.retryPending += stats.retryPending;
      totals.noRecipient += stats.noRecipient;
      totals.escalated += stats.escalated;
      totals.skipped += stats.skipped;
      totals.resendContentCleared += stats.resendContentCleared;
      // Verworfene Aufträge zählen zum Batch: auch dann können weitere fällig sein.
      if (stats.processed + stats.skipped < BATCH_SIZE) break;
    }
    if (
      totals.processed > 0 ||
      totals.escalated > 0 ||
      totals.skipped > 0 ||
      totals.resendContentCleared > 0
    ) {
      log.info(totals, 'mail-outbox-deliver: done');
    }
    return totals;
  },
  { connection, concurrency: 1 },
);
