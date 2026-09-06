'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withTenantContext } from '@taxtronik/db';
import {
  portalActionGuard,
  parseFormData,
  type ActionResult,
} from '@/server/actions/portal-action';
import { toActionError } from '@/server/auth/rbac';
import { checkPortalInboxThreadLimit, checkPortalWriteLimit } from '@/server/rate-limit';
import { compensateStorageCommit } from '@/server/documents/storage-compensation';
import {
  addPortalInboxMessageTx,
  createPortalInboxThreadTx,
  createPortalInboxUploadBatchTx,
  discardPortalInboxUploadBatchTx,
  markPortalInboxThreadReadTx,
} from '@/server/inbox/portal-mutations';
import {
  INBOX_MESSAGE_MAX_LENGTH,
  INBOX_SUBJECT_MAX_LENGTH,
  INBOX_TOPICS,
} from '@/server/inbox/constants';

// Fachkatalog: PORTAL-INBOX-SUBMISSION-001 (ungepruefter Entwurf),
// ACCESS-TENANT-RLS-001, CLIENT-MANDATE-LIFECYCLE-001,
// DOC-UPLOAD-JOURNAL-001, AUDIT-HASH-CHAIN-001, REQ-LIFECYCLE-001.

type BatchActionResult = ActionResult & { batchId?: string; expiresAt?: string };
type MessageActionResult = ActionResult & {
  threadId?: string;
  messageId?: string;
  idempotent?: boolean;
};

const optionalUuid = z
  .union([z.uuid(), z.literal('')])
  .optional()
  .transform((value) => value || undefined);

const BatchSchema = z
  .object({
    purpose: z.enum(['NEW_THREAD', 'REPLY']),
    targetThreadId: optionalUuid,
  })
  .superRefine((value, ctx) => {
    if (value.purpose === 'REPLY' && !value.targetThreadId) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetThreadId'],
        message: 'Zielverlauf fehlt.',
      });
    }
    if (value.purpose === 'NEW_THREAD' && value.targetThreadId) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetThreadId'],
        message: 'Für ein neues Anliegen ist kein Zielverlauf zulässig.',
      });
    }
  });

const ThreadSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(2, 'Bitte geben Sie einen Betreff an.')
    .max(INBOX_SUBJECT_MAX_LENGTH, 'Der Betreff ist zu lang.'),
  topic: z.enum(INBOX_TOPICS),
  body: z
    .string()
    .trim()
    .min(1, 'Bitte schreiben Sie eine Nachricht.')
    .max(INBOX_MESSAGE_MAX_LENGTH, 'Die Nachricht ist zu lang.'),
  clientMutationId: z.uuid('Ungültige Wiederholungs-ID.'),
  batchId: optionalUuid,
});

const MessageSchema = z.object({
  threadId: z.uuid(),
  body: z
    .string()
    .trim()
    .min(1, 'Bitte schreiben Sie eine Nachricht.')
    .max(INBOX_MESSAGE_MAX_LENGTH, 'Die Nachricht ist zu lang.'),
  clientMutationId: z.uuid('Ungültige Wiederholungs-ID.'),
  batchId: optionalUuid,
});

const IdSchema = z.object({ id: z.uuid() });

async function portalGuardWithRateLimit() {
  const guard = await portalActionGuard();
  if (!guard.ok) return guard;
  const limit = await checkPortalWriteLimit(guard.contactId);
  if (!limit.ok) {
    return {
      ok: false as const,
      error: 'Zu viele Aktionen. Bitte versuchen Sie es später erneut.',
      errorCode: 'RATE_LIMITED' as const,
    };
  }
  return guard;
}

function actorOf(guard: { tenantId: string; clientId: string; contactId: string }) {
  return {
    tenantId: guard.tenantId,
    clientId: guard.clientId,
    contactId: guard.contactId,
  };
}

export async function createInboxUploadBatchAction(formData: FormData): Promise<BatchActionResult> {
  const parsed = parseFormData(BatchSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await portalGuardWithRateLimit();
  if (!guard.ok) return guard;

  try {
    const batch = await withTenantContext(guard.ctx, (tx) =>
      createPortalInboxUploadBatchTx(tx, actorOf(guard), parsed.data),
    );
    revalidatePath('/portal/inbox');
    return { ok: true, batchId: batch.id, expiresAt: batch.expiresAt.toISOString() };
  } catch (error) {
    return toActionError(error);
  }
}

export async function discardInboxUploadBatchAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseFormData(IdSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await portalGuardWithRateLimit();
  if (!guard.ok) return guard;

  try {
    const discarded = await withTenantContext(guard.ctx, (tx) =>
      discardPortalInboxUploadBatchTx(tx, actorOf(guard), parsed.data.id),
    );
    if (discarded.discarded) {
      for (const attachment of discarded.attachments) {
        await compensateStorageCommit({
          tenantId: guard.tenantId,
          source: 'portal-inbox-draft-discarded',
          commit: {
            targetBucket: attachment.storageBucket,
            targetKey: attachment.storageKey,
            storageVersionId: attachment.storageVersionId,
            sha256: Buffer.from(attachment.sha256),
            sizeBytes: attachment.sizeBytes,
            immutable: false,
            retentionUntil: null,
            detectedMime: attachment.mimeType,
          },
          cause: new Error('PORTAL_INBOX_DRAFT_DISCARDED'),
        });
      }
    }
    revalidatePath('/portal/inbox');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}

export async function createInboxThreadAction(formData: FormData): Promise<MessageActionResult> {
  const parsed = parseFormData(ThreadSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await portalGuardWithRateLimit();
  if (!guard.ok) return guard;
  const threadLimit = await checkPortalInboxThreadLimit(guard.contactId);
  if (!threadLimit.ok) {
    return {
      ok: false,
      error: 'Zu viele neue Anliegen. Bitte versuchen Sie es später erneut.',
      errorCode: 'RATE_LIMITED',
    };
  }

  try {
    const result = await withTenantContext(guard.ctx, (tx) =>
      createPortalInboxThreadTx(tx, actorOf(guard), parsed.data),
    );
    revalidatePath('/portal');
    revalidatePath('/portal/inbox');
    return { ok: true, ...result };
  } catch (error) {
    return toActionError(error);
  }
}

export async function addInboxMessageAction(formData: FormData): Promise<MessageActionResult> {
  const parsed = parseFormData(MessageSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await portalGuardWithRateLimit();
  if (!guard.ok) return guard;

  try {
    const result = await withTenantContext(guard.ctx, (tx) =>
      addPortalInboxMessageTx(tx, actorOf(guard), parsed.data),
    );
    revalidatePath('/portal');
    revalidatePath('/portal/inbox');
    revalidatePath(`/portal/inbox/${parsed.data.threadId}`);
    return { ok: true, ...result };
  } catch (error) {
    return toActionError(error);
  }
}

export async function markInboxThreadReadAction(formData: FormData): Promise<ActionResult> {
  const parsed = parseFormData(IdSchema, formData);
  if (!parsed.ok) return parsed;
  const guard = await portalGuardWithRateLimit();
  if (!guard.ok) return guard;
  try {
    await withTenantContext(guard.ctx, (tx) =>
      markPortalInboxThreadReadTx(tx, actorOf(guard), parsed.data.id),
    );
    revalidatePath('/portal');
    revalidatePath('/portal/inbox');
    return { ok: true };
  } catch (error) {
    return toActionError(error);
  }
}
