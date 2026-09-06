'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard, parseFormData, type ActionResult } from '@/server/actions/staff-action';
import { toActionError } from '@/server/auth/rbac';
import { log } from '@/server/logger';
import { INBOX_MESSAGE_MAX_LENGTH, INBOX_SUBJECT_MAX_LENGTH } from '@/server/inbox/constants';
import {
  assignInboxThreadTx,
  claimInboxThreadTx,
  INBOX_REJECTION_REASONS,
  rejectInboxAttachmentTx,
  reopenInboxThreadTx,
  replyInboxThreadTx,
  resolveInboxThreadTx,
} from '@/server/inbox/staff-mutations';
import { acceptInboxAttachment } from '@/server/inbox/accept-attachment';
import { sendInboxClientActivityMail } from '@/server/inbox/client-notification';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';
import { ResumableDocumentUploadError } from '@/server/documents/resumable-upload';
import { assertStaffInboxClientTx } from '@/server/inbox/access';

// Fachkatalog: ACCESS-STAFF-PERMISSION-001, ACCESS-TENANT-RLS-001,
// CLIENT-MANDATE-LIFECYCLE-001, PORTAL-INBOX-SUBMISSION-001 (Entwurf),
// DOC-RETENTION-CLASS-001, DOC-UPLOAD-JOURNAL-001, DOC-PORTAL-SHARING-001.

type InboxStaffActionResult = ActionResult & {
  messageId?: string;
  documentId?: string;
  pendingDocumentId?: string;
  idempotent?: boolean;
  mailWarning?: string;
  safeToRetryMail?: boolean;
};

const ThreadIdSchema = z.object({ threadId: z.uuid() });
const AssignSchema = z.object({
  threadId: z.uuid(),
  staffId: z.union([z.uuid(), z.literal(''), z.undefined()]).transform((value) => value || null),
});
const ReplySchema = z.object({
  threadId: z.uuid(),
  body: z
    .string()
    .trim()
    .min(1, 'Bitte schreiben Sie eine Antwort.')
    .max(INBOX_MESSAGE_MAX_LENGTH, 'Die Antwort ist zu lang.'),
  clientMutationId: z.uuid('Ungültige Wiederholungs-ID.'),
});
const AcceptSchema = z.object({
  attachmentId: z.uuid(),
  title: z
    .string()
    .trim()
    .min(1, 'Bitte geben Sie einen Dokumenttitel an.')
    .max(INBOX_SUBJECT_MAX_LENGTH, 'Der Dokumenttitel ist zu lang.'),
  documentTypeId: z.uuid('Bitte wählen Sie einen Dokumenttyp.'),
});
const RejectSchema = z.object({
  attachmentId: z.uuid(),
  reason: z.enum(INBOX_REJECTION_REASONS),
});
const RetryMailSchema = z.object({ messageId: z.uuid() });

async function inboxStaffGuard() {
  return staffActionGuard({ requirePermission: 'PORTAL_INBOX_MANAGE' });
}

function revalidateThread(threadId: string): void {
  revalidatePath('/staff');
  revalidatePath('/staff/work');
  revalidatePath('/staff/inbox');
  revalidatePath(`/staff/inbox/${threadId}`);
}

export async function claimInboxThreadAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseFormData(ThreadIdSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;
  try {
    await withTenantContext(guard.ctx, (tx) =>
      claimInboxThreadTx(tx, guard.session, parsed.data.threadId),
    );
    revalidateThread(parsed.data.threadId);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function assignInboxThreadAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseFormData(AssignSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;
  try {
    await withTenantContext(guard.ctx, (tx) =>
      assignInboxThreadTx(tx, guard.session, parsed.data.threadId, parsed.data.staffId),
    );
    revalidateThread(parsed.data.threadId);
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function replyInboxThreadAction(formData: FormData): Promise<InboxStaffActionResult> {
  const parsed = parseFormData(ReplySchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;

  let saved;
  try {
    saved = await withTenantContext(guard.ctx, (tx) =>
      replyInboxThreadTx(tx, guard.session, parsed.data),
    );
  } catch (error) {
    return toActionError(error);
  }

  // Bewusst nach dem DB-Commit: ein SMTP-Fehler darf die unveraenderliche
  // Nachricht niemals zurueckrollen. Der Helper protokolliert den Ausgang
  // sichtbar und verhindert unsichere automatische Doppelzustellungen.
  let mail;
  try {
    mail = await sendInboxClientActivityMail({
      context: guard.ctx,
      tenantId: guard.tenantId,
      clientId: saved.clientId,
      staffId: guard.staffId,
      threadId: parsed.data.threadId,
      messageId: saved.messageId,
    });
  } catch (error) {
    log.error(
      {
        component: 'portal-inbox-reply-mail-journal',
        tenantId: guard.tenantId,
        threadId: parsed.data.threadId,
        messageId: saved.messageId,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      'portal inbox reply saved but mail result could not be journaled',
    );
    mail = { delivered: false, safeToRetry: false };
  }
  revalidateThread(parsed.data.threadId);
  revalidatePath('/portal/inbox');
  return {
    ok: true,
    messageId: saved.messageId,
    idempotent: saved.idempotent,
    ...(mail.delivered
      ? {}
      : {
          mailWarning:
            'Die Antwort wurde gespeichert, der E-Mail-Hinweis aber nicht vollständig zugestellt.',
          safeToRetryMail: mail.safeToRetry,
        }),
  };
}

export async function resolveInboxThreadAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseFormData(ThreadIdSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;
  try {
    await withTenantContext(guard.ctx, (tx) =>
      resolveInboxThreadTx(tx, guard.session, parsed.data.threadId),
    );
    revalidateThread(parsed.data.threadId);
    revalidatePath('/portal/inbox');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function reopenInboxThreadAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseFormData(ThreadIdSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;
  try {
    await withTenantContext(guard.ctx, (tx) =>
      reopenInboxThreadTx(tx, guard.session, parsed.data.threadId),
    );
    revalidateThread(parsed.data.threadId);
    revalidatePath('/portal/inbox');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function acceptInboxAttachmentAction(
  formData: FormData,
): Promise<InboxStaffActionResult> {
  const parsed = parseFormData(AcceptSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;
  try {
    const accepted = await acceptInboxAttachment({
      context: guard.ctx,
      session: guard.session,
      ...parsed.data,
    });
    if (!accepted.alreadyAccepted) {
      await compensateStorageCommit({
        tenantId: guard.tenantId,
        source: 'portal-inbox-staging-accepted',
        commit: {
          targetBucket: accepted.staging.storageBucket,
          targetKey: accepted.staging.storageKey,
          storageVersionId: accepted.staging.storageVersionId,
          sha256: accepted.staging.sha256,
          sizeBytes: accepted.staging.sizeBytes,
          immutable: false,
          retentionUntil: null,
          detectedMime: accepted.staging.mimeType,
        },
        cause: new Error('PORTAL_INBOX_STAGING_REPLACED_BY_DOCUMENT'),
      });
    }
    revalidatePath('/staff/inbox');
    revalidatePath('/staff/work');
    revalidatePath('/portal/inbox');
    return { ok: true, documentId: accepted.documentId };
  } catch (error) {
    if (error instanceof ResumableDocumentUploadError) {
      return {
        ok: false,
        error: 'Die Übernahme wurde unterbrochen und kann sicher fortgesetzt werden.',
        errorCode: 'CONFLICT',
        pendingDocumentId: error.pendingDocumentId,
      };
    }
    return toActionError(error);
  }
}

export async function rejectInboxAttachmentAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseFormData(RejectSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;
  try {
    await withTenantContext(guard.ctx, (tx) =>
      rejectInboxAttachmentTx(tx, guard.session, parsed.data.attachmentId, parsed.data.reason),
    );
    // Bytes bleiben ab Entscheidung sieben Tage in technischer Quarantaene;
    // der Inbox-Cleanup-Worker journalisiert erst danach die nachweisbare Loeschung.
    revalidatePath('/staff/inbox');
    revalidatePath('/staff/work');
    revalidatePath('/portal/inbox');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function retryInboxClientNotificationAction(
  formData: FormData,
): Promise<InboxStaffActionResult> {
  const parsed = parseFormData(RetryMailSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await inboxStaffGuard();
  if (!guard.ok) return guard;
  try {
    const message = await withTenantContext(guard.ctx, async (tx) => {
      const row = await tx.portalInboxMessage.findFirst({
        where: {
          id: parsed.data.messageId,
          tenantId: guard.tenantId,
          authorType: 'STAFF',
        },
        select: { id: true, clientId: true, threadId: true },
      });
      if (!row) throw new Error('MESSAGE_NOT_FOUND');
      await assertStaffInboxClientTx(tx, guard.session, row.clientId);
      return row;
    });
    const result = await sendInboxClientActivityMail({
      context: guard.ctx,
      tenantId: guard.tenantId,
      clientId: message.clientId,
      staffId: guard.staffId,
      threadId: message.threadId,
      messageId: message.id,
    });
    revalidateThread(message.threadId);
    return result.delivered
      ? { ok: true, messageId: message.id }
      : {
          ok: false,
          error: result.safeToRetry
            ? 'Der E-Mail-Hinweis konnte noch nicht zugestellt werden.'
            : 'Wegen möglicher Teilzustellung ist kein automatischer Neuversand zulässig.',
          errorCode: 'CONFLICT',
          messageId: message.id,
          safeToRetryMail: result.safeToRetry,
        };
  } catch (error) {
    return toActionError(error);
  }
}
