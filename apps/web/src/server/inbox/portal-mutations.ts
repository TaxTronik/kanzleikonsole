import { createHash } from 'node:crypto';
import type { TxClient } from '@taxtronik/db';
import { prismaBytes } from '@/server/db/prisma-bytes';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { assertActivePortalInboxIdentityTx } from './access';
import {
  INBOX_MAX_ATTACHMENTS,
  INBOX_MAX_OPEN_BATCHES,
  INBOX_MAX_TOTAL_BYTES,
  inboxBatchExpiresAt,
  type InboxTopic,
} from './constants';
import { resolveInboxNotificationRecipientsTx } from './routing';

// Fachkatalog: PORTAL-INBOX-SUBMISSION-001 (Entwurf),
// ACCESS-NOTIFICATION-RECIPIENT-001, AUDIT-HASH-CHAIN-001,
// REQ-LIFECYCLE-001. Diese Domäne verändert bewusst keinen Request.

export interface PortalInboxActor {
  tenantId: string;
  clientId: string;
  contactId: string;
}

interface ConsumableAttachment {
  id: string;
  sha256: Uint8Array;
  sizeBytes: bigint;
  mimeType: string;
  originalName: string;
  position: number;
}

function manifestHash(attachments: readonly ConsumableAttachment[]): Buffer {
  // Exakt dieselbe kanonische Darstellung wie der DB-Consume-Trigger.
  // Der Name ist Teil des unveraenderlichen Manifests, erscheint aber nie in
  // Audit, Notification, E-Mail oder normalen Logs.
  const canonical = attachments
    .map(
      (item) =>
        `${item.position}:${Buffer.from(item.sha256).toString('hex')}:${item.sizeBytes.toString()}:` +
        `${Buffer.from(item.mimeType, 'utf8').toString('base64')}:` +
        Buffer.from(item.originalName, 'utf8').toString('base64'),
    )
    .join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest();
}

async function consumeUploadBatchTx(
  tx: TxClient,
  actor: PortalInboxActor,
  input: {
    batchId?: string | null;
    purpose: 'NEW_THREAD' | 'REPLY';
    targetThreadId?: string | null;
    messageId: string;
  },
): Promise<number> {
  if (!input.batchId) return 0;

  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
      FROM "portal_inbox_upload_batch"
     WHERE "id" = ${input.batchId}::uuid
       AND "tenant_id" = ${actor.tenantId}::uuid
       AND "client_id" = ${actor.clientId}::uuid
       AND "created_by_contact_id" = ${actor.contactId}::uuid
     FOR UPDATE
  `;
  if (!locked[0]) throw new ActionError('Uploadentwurf nicht verfügbar.');

  const batch = await tx.portalInboxUploadBatch.findFirst({
    where: {
      id: input.batchId,
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      createdByContactId: actor.contactId,
      purpose: input.purpose,
      targetThreadId: input.targetThreadId ?? null,
      status: 'OPEN',
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true,
      attachments: {
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          sha256: true,
          sizeBytes: true,
          mimeType: true,
          originalName: true,
          position: true,
          messageId: true,
          scanStatus: true,
          decision: true,
        },
      },
    },
  });
  if (!batch) throw new ActionError('Uploadentwurf nicht verfügbar oder abgelaufen.');
  if (batch.attachments.length > INBOX_MAX_ATTACHMENTS) {
    throw new ActionError('Der Uploadentwurf überschreitet die Dateigrenze.');
  }
  const total = batch.attachments.reduce((sum, item) => sum + item.sizeBytes, 0n);
  if (total > BigInt(INBOX_MAX_TOTAL_BYTES)) {
    throw new ActionError('Der Uploadentwurf überschreitet die Gesamtgröße.');
  }
  if (
    batch.attachments.some(
      (item) =>
        item.messageId !== null ||
        item.scanStatus !== 'CLEAN' ||
        item.decision !== 'PENDING_REVIEW',
    )
  ) {
    throw new ActionError('Mindestens eine Anlage ist noch nicht sicher übertragbar.');
  }

  const bound = await tx.portalInboxAttachment.updateMany({
    where: {
      batchId: batch.id,
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      messageId: null,
      scanStatus: 'CLEAN',
      decision: 'PENDING_REVIEW',
    },
    data: { messageId: input.messageId },
  });
  if (bound.count !== batch.attachments.length) {
    throw new ActionError('Der Uploadentwurf wurde gleichzeitig geändert.');
  }

  const consumed = await tx.portalInboxUploadBatch.updateMany({
    where: { id: batch.id, status: 'OPEN' },
    data: {
      status: 'CONSUMED',
      consumedAt: new Date(),
      manifestSha256: prismaBytes(manifestHash(batch.attachments)),
    },
  });
  if (consumed.count !== 1) {
    throw new ActionError('Der Uploadentwurf wurde bereits verwendet.');
  }
  return batch.attachments.length;
}

async function markPortalReadTx(
  tx: TxClient,
  actor: PortalInboxActor,
  threadId: string,
  readAt: Date,
): Promise<void> {
  await tx.portalInboxRead.upsert({
    where: { threadId_contactId: { threadId, contactId: actor.contactId } },
    create: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      threadId,
      contactId: actor.contactId,
      lastReadAt: readAt,
    },
    update: { lastReadAt: readAt },
  });
}

async function notifyStaffAboutClientMessageTx(
  tx: TxClient,
  actor: PortalInboxActor,
  threadId: string,
  assignedStaffId: string | null,
): Promise<void> {
  const recipients = await resolveInboxNotificationRecipientsTx(tx, {
    tenantId: actor.tenantId,
    clientId: actor.clientId,
    assignedStaffId,
  });
  for (const staffId of recipients) {
    // Dedizierter write-only DB-Pfad: Der Portal-Akteur kann weder Titel,
    // Body noch Link beeinflussen und erhaelt keine Notification-Daten zurueck.
    await tx.$queryRaw`
      SELECT app.notify_portal_inbox_activity(
        ${actor.tenantId}::uuid,
        ${threadId}::uuid,
        ${staffId}::uuid
      )
    `;
  }
}

async function findIdempotentClientMessageTx(
  tx: TxClient,
  actor: PortalInboxActor,
  clientMutationId: string,
) {
  const message = await tx.portalInboxMessage.findFirst({
    where: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      authorType: 'CLIENT_CONTACT',
      authorId: actor.contactId,
      clientMutationId,
    },
    select: {
      id: true,
      body: true,
      threadId: true,
      thread: { select: { subject: true, topic: true } },
    },
  });
  if (!message) return null;
  const binding = await tx.auditLog.findFirst({
    where: {
      tenantId: actor.tenantId,
      action: 'portal_inbox.submission_bound',
      resourceType: 'portal_inbox_message',
      resourceId: message.id,
    },
    orderBy: { id: 'desc' },
    select: { after: true },
  });
  const after = binding?.after;
  const storedBatchId =
    after !== null && typeof after === 'object' && !Array.isArray(after)
      ? (after as Record<string, unknown>)['batchId']
      : undefined;
  return {
    ...message,
    submissionBatchId:
      storedBatchId === null || typeof storedBatchId === 'string' ? storedBatchId : undefined,
  };
}

function idempotentBatchMatches(
  storedBatchId: string | null | undefined,
  batchId: string | null | undefined,
): boolean {
  if (storedBatchId === undefined) return false;
  return storedBatchId === (batchId ?? null);
}

async function recordSubmissionBindingTx(
  tx: TxClient,
  actor: PortalInboxActor,
  messageId: string,
  batchId: string | null | undefined,
  attachmentCount: number,
): Promise<void> {
  await evidenceService.record(tx, {
    tenantId: actor.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: actor.contactId,
    action: 'portal_inbox.submission_bound',
    resourceType: 'portal_inbox_message',
    resourceId: messageId,
    // Nur pseudonyme technische Bindung; keine Namen, Inhalte oder Hashes.
    after: { batchId: batchId ?? null, attachmentCount },
  });
}

async function lockClientMutationTx(
  tx: TxClient,
  actor: PortalInboxActor,
  clientMutationId: string,
): Promise<void> {
  // Serialisiert echte Parallel-Doppelclicks vor dem Idempotenz-Lookup. Ohne
  // diesen Lock könnte der zweite Request erst am Unique-Constraint scheitern,
  // statt den bereits gespeicherten Erfolg zuverlässig zurückzugeben.
  const lockKey = [
    'portal-inbox-client-mutation',
    actor.tenantId,
    actor.clientId,
    actor.contactId,
    clientMutationId,
  ].join(':');
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `;
}

export async function createPortalInboxUploadBatchTx(
  tx: TxClient,
  actor: PortalInboxActor,
  input: { purpose: 'NEW_THREAD' | 'REPLY'; targetThreadId?: string | null },
) {
  await assertActivePortalInboxIdentityTx(tx, { ...actor, requireUpload: true });
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${'portal-inbox-open-batches:' + actor.contactId}, 0)
    )
  `;
  const openCount = await tx.portalInboxUploadBatch.count({
    where: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      createdByContactId: actor.contactId,
      status: 'OPEN',
      expiresAt: { gt: new Date() },
    },
  });
  if (openCount >= INBOX_MAX_OPEN_BATCHES) {
    throw new ActionError('Es sind bereits drei offene Uploadentwürfe vorhanden.');
  }

  const targetThreadId = input.targetThreadId ?? null;
  if (input.purpose === 'NEW_THREAD' && targetThreadId) {
    throw new ActionError('Für ein neues Anliegen ist kein Zielverlauf zulässig.');
  }
  if (input.purpose === 'REPLY') {
    if (!targetThreadId) throw new ActionError('Zielverlauf fehlt.');
    const thread = await tx.portalInboxThread.findFirst({
      where: {
        id: targetThreadId,
        tenantId: actor.tenantId,
        clientId: actor.clientId,
        status: 'OPEN',
      },
      select: { id: true },
    });
    if (!thread) throw new ActionError('Der Verlauf ist nicht beschreibbar.');
  }

  const batch = await tx.portalInboxUploadBatch.create({
    data: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      createdByContactId: actor.contactId,
      purpose: input.purpose,
      targetThreadId,
      expiresAt: inboxBatchExpiresAt(),
    },
    select: { id: true, expiresAt: true },
  });
  await evidenceService.record(tx, {
    tenantId: actor.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: actor.contactId,
    action: 'portal_inbox.upload_batch_created',
    resourceType: 'portal_inbox_upload_batch',
    resourceId: batch.id,
    after: { purpose: input.purpose, targetThreadId },
  });
  return batch;
}

export async function discardPortalInboxUploadBatchTx(
  tx: TxClient,
  actor: PortalInboxActor,
  batchId: string,
) {
  await assertActivePortalInboxIdentityTx(tx, { ...actor, requireUpload: true });
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
      FROM "portal_inbox_upload_batch"
     WHERE "id" = ${batchId}::uuid
       AND "tenant_id" = ${actor.tenantId}::uuid
       AND "client_id" = ${actor.clientId}::uuid
       AND "created_by_contact_id" = ${actor.contactId}::uuid
     FOR UPDATE
  `;
  if (!locked[0]) throw new ActionError('Uploadentwurf nicht verfügbar.');
  const batch = await tx.portalInboxUploadBatch.findFirst({
    where: {
      id: batchId,
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      createdByContactId: actor.contactId,
    },
    select: {
      status: true,
      attachments: {
        select: {
          id: true,
          storageBucket: true,
          storageKey: true,
          storageVersionId: true,
          sha256: true,
          sizeBytes: true,
          mimeType: true,
          scanStatus: true,
        },
      },
    },
  });
  if (!batch) throw new ActionError('Uploadentwurf nicht verfügbar.');
  if (batch.status === 'DISCARDED') return { discarded: false, attachments: [] };
  if (batch.status !== 'OPEN') throw new ActionError('Der Uploadentwurf wurde bereits verwendet.');
  if (batch.attachments.some((attachment) => attachment.scanStatus === 'PENDING')) {
    throw new ActionError('Ein Upload wird noch abgeschlossen. Bitte versuchen Sie es erneut.');
  }

  await tx.portalInboxUploadBatch.update({
    where: { id: batchId },
    data: { status: 'DISCARDED', discardedAt: new Date() },
  });
  await evidenceService.record(tx, {
    tenantId: actor.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: actor.contactId,
    action: 'portal_inbox.upload_batch_discarded',
    resourceType: 'portal_inbox_upload_batch',
    resourceId: batchId,
    after: { attachmentCount: batch.attachments.length },
  });
  return { discarded: true, attachments: batch.attachments };
}

export async function createPortalInboxThreadTx(
  tx: TxClient,
  actor: PortalInboxActor,
  input: {
    subject: string;
    topic: InboxTopic;
    body: string;
    clientMutationId: string;
    batchId?: string | null;
  },
) {
  await assertActivePortalInboxIdentityTx(tx, { ...actor, requireUpload: Boolean(input.batchId) });
  await lockClientMutationTx(tx, actor, input.clientMutationId);
  const existing = await findIdempotentClientMessageTx(tx, actor, input.clientMutationId);
  if (existing) {
    if (
      existing.body !== input.body ||
      existing.thread.subject !== input.subject ||
      existing.thread.topic !== input.topic ||
      !idempotentBatchMatches(existing.submissionBatchId, input.batchId)
    ) {
      throw new ActionError('Diese Wiederholungs-ID wurde bereits anders verwendet.');
    }
    return { threadId: existing.threadId, messageId: existing.id, idempotent: true };
  }

  const thread = await tx.portalInboxThread.create({
    data: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      subject: input.subject,
      topic: input.topic,
      status: 'OPEN',
      attention: 'STAFF',
      createdByContactId: actor.contactId,
    },
    // Der BEFORE-Trigger bestimmt den eindeutigen berechtigten
    // Hauptbearbeiter. Ein Portal-Write kann keinen Staff auswählen.
    select: { id: true, assignedStaffId: true },
  });
  const message = await tx.portalInboxMessage.create({
    data: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      threadId: thread.id,
      authorType: 'CLIENT_CONTACT',
      authorId: actor.contactId,
      body: input.body,
      clientMutationId: input.clientMutationId,
    },
    select: { id: true, createdAt: true },
  });
  const attachmentCount = await consumeUploadBatchTx(tx, actor, {
    batchId: input.batchId,
    purpose: 'NEW_THREAD',
    messageId: message.id,
  });
  await recordSubmissionBindingTx(tx, actor, message.id, input.batchId, attachmentCount);
  // Der AFTER-INSERT-Trigger projiziert Zeit und Aufmerksamkeit atomar aus
  // der unveränderlichen Nachricht. Portal-Kontakte erhalten bewusst keine
  // allgemeine UPDATE-Policy auf Thread-Metadaten.
  await markPortalReadTx(tx, actor, thread.id, message.createdAt);
  await notifyStaffAboutClientMessageTx(tx, actor, thread.id, thread.assignedStaffId);
  await evidenceService.record(tx, {
    tenantId: actor.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: actor.contactId,
    action: 'portal_inbox.thread_created',
    resourceType: 'portal_inbox_thread',
    resourceId: thread.id,
    after: {
      topic: input.topic,
      subjectLength: input.subject.length,
      messageLength: input.body.length,
      attachmentCount,
      assigned: thread.assignedStaffId !== null,
    },
  });
  return { threadId: thread.id, messageId: message.id, idempotent: false };
}

export async function addPortalInboxMessageTx(
  tx: TxClient,
  actor: PortalInboxActor,
  input: {
    threadId: string;
    body: string;
    clientMutationId: string;
    batchId?: string | null;
  },
) {
  await assertActivePortalInboxIdentityTx(tx, { ...actor, requireUpload: Boolean(input.batchId) });
  await lockClientMutationTx(tx, actor, input.clientMutationId);
  const existing = await findIdempotentClientMessageTx(tx, actor, input.clientMutationId);
  if (existing) {
    if (
      existing.threadId !== input.threadId ||
      existing.body !== input.body ||
      !idempotentBatchMatches(existing.submissionBatchId, input.batchId)
    ) {
      throw new ActionError('Diese Wiederholungs-ID wurde bereits anders verwendet.');
    }
    return { threadId: existing.threadId, messageId: existing.id, idempotent: true };
  }

  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
      FROM "portal_inbox_thread"
     WHERE "id" = ${input.threadId}::uuid
       AND "tenant_id" = ${actor.tenantId}::uuid
       AND "client_id" = ${actor.clientId}::uuid
     FOR UPDATE
  `;
  if (!locked[0]) throw new ActionError('Verlauf nicht gefunden.');
  const thread = await tx.portalInboxThread.findFirst({
    where: {
      id: input.threadId,
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      status: 'OPEN',
    },
    select: { id: true, assignedStaffId: true },
  });
  if (!thread) {
    throw new ActionError('Dieser Verlauf ist erledigt. Bitte beginnen Sie ein neues Anliegen.');
  }

  const message = await tx.portalInboxMessage.create({
    data: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      threadId: thread.id,
      authorType: 'CLIENT_CONTACT',
      authorId: actor.contactId,
      body: input.body,
      clientMutationId: input.clientMutationId,
    },
    select: { id: true, createdAt: true },
  });
  const attachmentCount = await consumeUploadBatchTx(tx, actor, {
    batchId: input.batchId,
    purpose: 'REPLY',
    targetThreadId: thread.id,
    messageId: message.id,
  });
  await recordSubmissionBindingTx(tx, actor, message.id, input.batchId, attachmentCount);
  // Zeit und Aufmerksamkeit stammen atomar aus dem Message-Insert-Trigger.
  await markPortalReadTx(tx, actor, thread.id, message.createdAt);
  await notifyStaffAboutClientMessageTx(tx, actor, thread.id, thread.assignedStaffId);
  await evidenceService.record(tx, {
    tenantId: actor.tenantId,
    actorType: 'CLIENT_CONTACT',
    actorId: actor.contactId,
    action: 'portal_inbox.message_created',
    resourceType: 'portal_inbox_message',
    resourceId: message.id,
    after: {
      threadId: thread.id,
      messageLength: input.body.length,
      attachmentCount,
    },
  });
  return { threadId: thread.id, messageId: message.id, idempotent: false };
}

export async function markPortalInboxThreadReadTx(
  tx: TxClient,
  actor: PortalInboxActor,
  threadId: string,
): Promise<void> {
  await assertActivePortalInboxIdentityTx(tx, actor);
  const thread = await tx.portalInboxThread.findFirst({
    where: { id: threadId, tenantId: actor.tenantId, clientId: actor.clientId },
    select: { lastMessageAt: true },
  });
  if (!thread) throw new ActionError('Verlauf nicht gefunden.');
  await markPortalReadTx(tx, actor, threadId, thread.lastMessageAt);
}
