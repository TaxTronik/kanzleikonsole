import type { TxClient } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import { assertStaffInboxClientTx, eligibleInboxStaffIdsTx } from './access';

// Fachkatalog: ACCESS-STAFF-PERMISSION-001, ACCESS-TENANT-RLS-001,
// ACCESS-NOTIFICATION-RECIPIENT-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf).

export const INBOX_REJECTION_REASONS = [
  'NOT_REQUIRED',
  'DUPLICATE',
  'UNSUPPORTED',
  'OTHER',
] as const;
export type InboxRejectionReason = (typeof INBOX_REJECTION_REASONS)[number];

async function lockThreadTx(
  tx: TxClient,
  tenantId: string,
  threadId: string,
): Promise<{ id: string; clientId: string }> {
  const [locked] = await tx.$queryRaw<Array<{ id: string; clientId: string }>>`
    SELECT "id", "client_id" AS "clientId"
      FROM "portal_inbox_thread"
     WHERE "id" = ${threadId}::uuid
       AND "tenant_id" = ${tenantId}::uuid
     FOR UPDATE
  `;
  if (!locked) throw new ActionError('Verlauf nicht gefunden.');
  return locked;
}

async function clearStaffActivityNotificationTx(
  tx: TxClient,
  tenantId: string,
  threadId: string,
): Promise<void> {
  await resolveNotificationsTx(tx, {
    tenantId,
    resources: [{ resourceType: 'portal_inbox_thread', resourceId: threadId }],
    kinds: ['PORTAL_INBOX_ACTIVITY'],
  });
}

async function lockStaffMutationTx(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  clientMutationId: string,
): Promise<void> {
  const lockKey = ['portal-inbox-staff-mutation', tenantId, staffId, clientMutationId].join(':');
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `;
}

export async function claimInboxThreadTx(tx: TxClient, session: StaffSession, threadId: string) {
  const { tenantId, staffId } = session.user;
  const locked = await lockThreadTx(tx, tenantId, threadId);
  await assertStaffInboxClientTx(tx, session, locked.clientId);
  const thread = await tx.portalInboxThread.findFirst({
    where: { id: threadId, tenantId, clientId: locked.clientId, status: 'OPEN' },
    select: { assignedStaffId: true },
  });
  if (!thread) throw new ActionError('Nur offene Verläufe können übernommen werden.');
  if (thread.assignedStaffId === staffId) return { claimed: false };
  if (thread.assignedStaffId) throw new ActionError('Der Verlauf wurde bereits übernommen.');

  const claimed = await tx.portalInboxThread.updateMany({
    where: { id: threadId, assignedStaffId: null, status: 'OPEN' },
    data: { assignedStaffId: staffId },
  });
  if (claimed.count !== 1) throw new ActionError('Der Verlauf wurde gleichzeitig übernommen.');
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'portal_inbox.thread_claimed',
    resourceType: 'portal_inbox_thread',
    resourceId: threadId,
    after: { assignedStaffId: staffId },
  });
  return { claimed: true };
}

export async function assignInboxThreadTx(
  tx: TxClient,
  session: StaffSession,
  threadId: string,
  targetStaffId: string | null,
) {
  const { tenantId, staffId } = session.user;
  const locked = await lockThreadTx(tx, tenantId, threadId);
  await assertStaffInboxClientTx(tx, session, locked.clientId);
  const thread = await tx.portalInboxThread.findFirst({
    where: { id: threadId, tenantId, clientId: locked.clientId, status: 'OPEN' },
    select: { assignedStaffId: true },
  });
  if (!thread) throw new ActionError('Nur offene Verläufe können zugewiesen werden.');
  if (targetStaffId) {
    const eligible = await eligibleInboxStaffIdsTx(tx, tenantId, locked.clientId, [targetStaffId]);
    if (!eligible.has(targetStaffId)) {
      throw new ActionError('Die ausgewählte Person darf diesen Mandanten nicht bearbeiten.');
    }
  }
  if (thread.assignedStaffId === targetStaffId) return { assigned: false };

  await tx.portalInboxThread.update({
    where: { id: threadId },
    data: { assignedStaffId: targetStaffId },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'portal_inbox.thread_assigned',
    resourceType: 'portal_inbox_thread',
    resourceId: threadId,
    before: { assignedStaffId: thread.assignedStaffId },
    after: { assignedStaffId: targetStaffId },
  });
  return { assigned: true };
}

export async function replyInboxThreadTx(
  tx: TxClient,
  session: StaffSession,
  input: { threadId: string; body: string; clientMutationId: string },
) {
  const { tenantId, staffId } = session.user;
  await lockStaffMutationTx(tx, tenantId, staffId, input.clientMutationId);
  const existing = await tx.portalInboxMessage.findFirst({
    where: {
      tenantId,
      authorType: 'STAFF',
      authorId: staffId,
      clientMutationId: input.clientMutationId,
    },
    select: { id: true, threadId: true, clientId: true, body: true },
  });
  if (existing) {
    if (existing.threadId !== input.threadId || existing.body !== input.body) {
      throw new ActionError('Diese Wiederholungs-ID wurde bereits anders verwendet.');
    }
    await assertStaffInboxClientTx(tx, session, existing.clientId);
    return {
      messageId: existing.id,
      clientId: existing.clientId,
      idempotent: true,
    };
  }

  const locked = await lockThreadTx(tx, tenantId, input.threadId);
  await assertStaffInboxClientTx(tx, session, locked.clientId);
  const thread = await tx.portalInboxThread.findFirst({
    where: { id: input.threadId, tenantId, clientId: locked.clientId, status: 'OPEN' },
    select: { id: true },
  });
  if (!thread) throw new ActionError('Der Verlauf ist erledigt. Öffnen Sie ihn zuerst wieder.');

  const message = await tx.portalInboxMessage.create({
    data: {
      tenantId,
      clientId: locked.clientId,
      threadId: thread.id,
      authorType: 'STAFF',
      authorId: staffId,
      body: input.body,
      clientMutationId: input.clientMutationId,
    },
    select: { id: true, createdAt: true },
  });
  await tx.portalInboxThread.update({
    where: { id: thread.id },
    data: { attention: 'CLIENT', lastMessageAt: message.createdAt },
  });
  await clearStaffActivityNotificationTx(tx, tenantId, thread.id);
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'portal_inbox.staff_reply_created',
    resourceType: 'portal_inbox_message',
    resourceId: message.id,
    after: { threadId: thread.id, messageLength: input.body.length },
  });
  return { messageId: message.id, clientId: locked.clientId, idempotent: false };
}

export async function resolveInboxThreadTx(tx: TxClient, session: StaffSession, threadId: string) {
  const { tenantId, staffId } = session.user;
  const locked = await lockThreadTx(tx, tenantId, threadId);
  await assertStaffInboxClientTx(tx, session, locked.clientId);
  const thread = await tx.portalInboxThread.findFirst({
    where: { id: threadId, tenantId, clientId: locked.clientId },
    select: { status: true, attention: true },
  });
  if (!thread) throw new ActionError('Verlauf nicht gefunden.');
  if (thread.status === 'RESOLVED') return { resolved: false };
  const pendingAttachments = await tx.portalInboxAttachment.count({
    where: {
      tenantId,
      clientId: locked.clientId,
      decision: 'PENDING_REVIEW',
      message: { threadId },
    },
  });
  if (pendingAttachments > 0) {
    throw new ActionError(
      'Offene Anlagen müssen vor dem Erledigen übernommen oder abgelehnt werden.',
    );
  }
  const now = new Date();
  await tx.portalInboxThread.update({
    where: { id: threadId },
    data: {
      status: 'RESOLVED',
      attention: 'NONE',
      resolvedAt: now,
      resolvedByStaffId: staffId,
    },
  });
  await clearStaffActivityNotificationTx(tx, tenantId, threadId);
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'portal_inbox.thread_resolved',
    resourceType: 'portal_inbox_thread',
    resourceId: threadId,
    before: { status: thread.status, attention: thread.attention },
    after: { status: 'RESOLVED', attention: 'NONE' },
  });
  return { resolved: true };
}

export async function reopenInboxThreadTx(tx: TxClient, session: StaffSession, threadId: string) {
  const { tenantId, staffId } = session.user;
  const locked = await lockThreadTx(tx, tenantId, threadId);
  await assertStaffInboxClientTx(tx, session, locked.clientId);
  const thread = await tx.portalInboxThread.findFirst({
    where: { id: threadId, tenantId, clientId: locked.clientId },
    select: {
      status: true,
      messages: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { authorType: true },
      },
    },
  });
  if (!thread) throw new ActionError('Verlauf nicht gefunden.');
  if (thread.status === 'OPEN') return { reopened: false };
  const attention = thread.messages[0]?.authorType === 'STAFF' ? 'CLIENT' : 'STAFF';
  await tx.portalInboxThread.update({
    where: { id: threadId },
    data: {
      status: 'OPEN',
      attention,
      resolvedAt: null,
      resolvedByStaffId: null,
    },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'portal_inbox.thread_reopened',
    resourceType: 'portal_inbox_thread',
    resourceId: threadId,
    after: { status: 'OPEN', attention },
  });
  return { reopened: true };
}

export async function rejectInboxAttachmentTx(
  tx: TxClient,
  session: StaffSession,
  attachmentId: string,
  reason: InboxRejectionReason,
) {
  const { tenantId, staffId } = session.user;
  const [locked] = await tx.$queryRaw<Array<{ id: string; clientId: string }>>`
    SELECT "id", "client_id" AS "clientId"
      FROM "portal_inbox_attachment"
     WHERE "id" = ${attachmentId}::uuid
       AND "tenant_id" = ${tenantId}::uuid
     FOR UPDATE
  `;
  if (!locked) throw new ActionError('Anlage nicht gefunden.');
  await assertStaffInboxClientTx(tx, session, locked.clientId, { requireUpload: true });
  const attachment = await tx.portalInboxAttachment.findFirst({
    where: {
      id: attachmentId,
      tenantId,
      clientId: locked.clientId,
      messageId: { not: null },
      scanStatus: 'CLEAN',
    },
    select: { decision: true, messageId: true, acceptedDocumentId: true },
  });
  if (!attachment) throw new ActionError('Anlage nicht verfügbar.');
  if (attachment.decision === 'REJECTED') return { rejected: false };
  if (attachment.decision !== 'PENDING_REVIEW') {
    throw new ActionError('Über diese Anlage wurde bereits entschieden.');
  }

  let pendingAcceptanceAborted = false;
  if (attachment.acceptedDocumentId) {
    const [aborted] = await tx.$queryRaw<Array<{ rejected: boolean }>>`
      SELECT app.reject_pending_portal_inbox_attachment(
        ${attachmentId}::uuid,
        ${reason}::text
      ) AS rejected
    `;
    if (aborted?.rejected !== true) {
      throw new ActionError('Die unterbrochene Übernahme konnte nicht sicher abgebrochen werden.');
    }
    pendingAcceptanceAborted = true;
  } else {
    await tx.portalInboxAttachment.update({
      where: { id: attachmentId },
      data: {
        decision: 'REJECTED',
        rejectionReason: reason,
        decidedByStaffId: staffId,
        decidedAt: new Date(),
      },
    });
  }
  await evidenceService.record(tx, {
    tenantId,
    actorType: 'STAFF',
    actorId: staffId,
    action: 'portal_inbox.attachment_rejected',
    resourceType: 'portal_inbox_attachment',
    resourceId: attachmentId,
    after: { messageId: attachment.messageId, reason, pendingAcceptanceAborted },
  });
  return { rejected: true };
}
