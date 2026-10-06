// Review-Befund K-02: Die Posteingangs-Actions laufen über staffAction. Gesichert
// wird der unveränderte Ablauf: Eingabeprüfung vor dem Gate, Einzelrecht
// PORTAL_INBOX_MANAGE, revalidierte Pfade und die Sonderabbildungen
// (unterbrochene Übernahme, nicht zugestellter E-Mail-Hinweis).
// Fachkatalog: ACCESS-STAFF-PERMISSION-001, DOC-UPLOAD-JOURNAL-001,
// PORTAL-INBOX-SUBMISSION-001 (Entwurf).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  tx: { portalInboxMessage: { findFirst: vi.fn() } },
  withTenantContext: vi.fn(),
  revalidatePath: vi.fn(),
  claim: vi.fn(),
  resolve: vi.fn(),
  reply: vi.fn(),
  accept: vi.fn(),
  compensate: vi.fn(),
  sendMail: vi.fn(),
  assertClient: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/logger', () => ({ log: { error: h.logError, warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/server/inbox/staff-mutations', () => ({
  INBOX_REJECTION_REASONS: ['NOT_REQUIRED', 'DUPLICATE', 'UNSUPPORTED', 'OTHER'],
  assignInboxThreadTx: vi.fn(),
  claimInboxThreadTx: h.claim,
  rejectInboxAttachmentTx: vi.fn(),
  reopenInboxThreadTx: vi.fn(),
  replyInboxThreadTx: h.reply,
  resolveInboxThreadTx: h.resolve,
}));
vi.mock('@/server/inbox/accept-attachment', () => ({ acceptInboxAttachment: h.accept }));
vi.mock('@/server/inbox/client-notification', () => ({
  sendInboxClientActivityMail: h.sendMail,
}));
vi.mock('@/server/inbox/access', () => ({ assertStaffInboxClientTx: h.assertClient }));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: h.compensate,
}));
vi.mock('@/server/documents/resumable-upload', () => ({
  ResumableDocumentUploadError: class ResumableDocumentUploadError extends Error {
    constructor(
      readonly phase: string,
      cause: unknown,
      readonly pendingDocumentId?: string,
    ) {
      super(cause instanceof Error ? cause.message : 'DOCUMENT_UPLOAD_FAILED');
    }
  },
}));
vi.mock('@/server/actions/staff-action', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  const { parseFormData } = await vi.importActual<typeof import('@/server/actions/form-data')>(
    '@/server/actions/form-data',
  );
  const { createActionRunner } = await vi.importActual<
    typeof import('@/server/actions/action-runner')
  >('@/server/actions/action-runner');
  return { ActionError, parseFormData, staffAction: createActionRunner(h.guard) };
});

import { ActionError } from '@/server/actions/action-error';
import { ResumableDocumentUploadError } from '@/server/documents/resumable-upload';
import {
  acceptInboxAttachmentAction,
  claimInboxThreadAction,
  replyInboxThreadAction,
  resolveInboxThreadAction,
  retryInboxClientNotificationAction,
} from '../actions';

const THREAD_ID = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const MESSAGE_ID = '7a2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5d';
const CLIENT_ID = '8b3c4d5e-6f7a-4b8c-8d9e-1f2a3b4c5d6e';
const ATTACHMENT_ID = '9c4d5e6f-7a8b-4c9d-9e0f-2a3b4c5d6e7f';
const DOCUMENT_TYPE_ID = '0d5e6f7a-8b9c-4d0e-8f1a-3b4c5d6e7f8a';
const DOCUMENT_ID = '1e6f7a8b-9c0d-4e1f-9a2b-4c5d6e7f8a9b';
const SESSION = { user: { id: 'staff-1', tenantId: 'tenant-1' } };
const STAFF = {
  tenantId: 'tenant-1',
  staffId: 'staff-1',
  ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  session: SESSION,
};
const THREAD_PATHS = ['/staff', '/staff/work', '/staff/inbox', `/staff/inbox/${THREAD_ID}`];

function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

function revalidatedPaths(): string[] {
  return h.revalidatePath.mock.calls.map(([path]) => path as string);
}

const acceptForm = () =>
  form({
    attachmentId: ATTACHMENT_ID,
    title: 'Lohnsteuerbescheinigung',
    documentTypeId: DOCUMENT_TYPE_ID,
  });

describe('Staff-Posteingang über staffAction (K-02)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.guard.mockResolvedValue({ ok: true, ...STAFF });
    h.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(h.tx),
    );
  });

  it('prüft die Eingabe vor dem Gate und meldet Feldfehler', async () => {
    const result = await claimInboxThreadAction(form({ threadId: 'kein-thread' }));

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { threadId: expect.any(Array) },
    });
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
  });

  it('verlangt PORTAL_INBOX_MANAGE und gibt die Ablehnung unverändert zurück', async () => {
    h.guard.mockResolvedValueOnce({
      ok: false,
      error: 'Keine Berechtigung (PORTAL_INBOX_MANAGE).',
    });

    await expect(resolveInboxThreadAction(form({ threadId: THREAD_ID }))).resolves.toEqual({
      ok: false,
      error: 'Keine Berechtigung (PORTAL_INBOX_MANAGE).',
    });
    expect(h.guard).toHaveBeenCalledWith({ requirePermission: 'PORTAL_INBOX_MANAGE' });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('revalidiert nach dem Abschluss Thread, Arbeitsliste und Portal', async () => {
    await expect(resolveInboxThreadAction(form({ threadId: THREAD_ID }))).resolves.toEqual({
      ok: true,
    });

    expect(h.resolve).toHaveBeenCalledWith(h.tx, SESSION, THREAD_ID);
    expect(revalidatedPaths()).toEqual([...THREAD_PATHS, '/portal/inbox']);
  });

  it('meldet einen Fachfehler aus der Transaktion als Ergebnis, ohne zu revalidieren', async () => {
    h.claim.mockRejectedValueOnce(new ActionError('Der Vorgang ist bereits zugewiesen.'));

    await expect(claimInboxThreadAction(form({ threadId: THREAD_ID }))).resolves.toEqual({
      ok: false,
      error: 'Der Vorgang ist bereits zugewiesen.',
    });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('meldet eine unterbrochene Übernahme als fortsetzbaren Konflikt', async () => {
    h.accept.mockRejectedValueOnce(
      new ResumableDocumentUploadError('commit', new Error('S3 nicht erreichbar'), DOCUMENT_ID),
    );

    await expect(acceptInboxAttachmentAction(acceptForm())).resolves.toEqual({
      ok: false,
      error: 'Die Übernahme wurde unterbrochen und kann sicher fortgesetzt werden.',
      errorCode: 'CONFLICT',
      pendingDocumentId: DOCUMENT_ID,
    });
    expect(h.compensate).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('räumt nach der Übernahme die Staging-Kopie ab und revalidiert Listen und Portal', async () => {
    h.accept.mockResolvedValueOnce({
      alreadyAccepted: false,
      documentId: DOCUMENT_ID,
      staging: {
        storageBucket: 'staging',
        storageKey: 'inbox/a.pdf',
        storageVersionId: 'v1',
        sha256: 'ab'.repeat(32),
        sizeBytes: 12,
        mimeType: 'application/pdf',
      },
    });

    await expect(acceptInboxAttachmentAction(acceptForm())).resolves.toEqual({
      ok: true,
      documentId: DOCUMENT_ID,
    });
    expect(h.accept).toHaveBeenCalledWith({
      context: STAFF.ctx,
      session: SESSION,
      attachmentId: ATTACHMENT_ID,
      title: 'Lohnsteuerbescheinigung',
      documentTypeId: DOCUMENT_TYPE_ID,
    });
    expect(h.compensate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', source: 'portal-inbox-staging-accepted' }),
    );
    expect(revalidatedPaths()).toEqual(['/staff/inbox', '/staff/work', '/portal/inbox']);
  });

  it('meldet einen nicht zustellbaren E-Mail-Hinweis als Konflikt und revalidiert den Thread', async () => {
    h.tx.portalInboxMessage.findFirst.mockResolvedValueOnce({
      id: MESSAGE_ID,
      clientId: CLIENT_ID,
      threadId: THREAD_ID,
    });
    h.sendMail.mockResolvedValueOnce({ delivered: false, safeToRetry: false });

    await expect(
      retryInboxClientNotificationAction(form({ messageId: MESSAGE_ID })),
    ).resolves.toEqual({
      ok: false,
      error: 'Wegen möglicher Teilzustellung ist kein automatischer Neuversand zulässig.',
      errorCode: 'CONFLICT',
      messageId: MESSAGE_ID,
      safeToRetryMail: false,
    });
    expect(h.assertClient).toHaveBeenCalledWith(h.tx, SESSION, CLIENT_ID);
    expect(revalidatedPaths()).toEqual(THREAD_PATHS);
  });

  it('meldet die gespeicherte Antwort auch dann, wenn der Mail-Ausgang nicht journalisiert wird', async () => {
    h.reply.mockResolvedValueOnce({
      clientId: CLIENT_ID,
      messageId: MESSAGE_ID,
      idempotent: false,
    });
    h.sendMail.mockRejectedValueOnce(new Error('SMTP'));

    await expect(
      replyInboxThreadAction(
        form({
          threadId: THREAD_ID,
          body: 'Danke, ist angekommen.',
          clientMutationId: DOCUMENT_ID,
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      messageId: MESSAGE_ID,
      idempotent: false,
      mailWarning:
        'Die Antwort wurde gespeichert, der E-Mail-Hinweis aber nicht vollständig zugestellt.',
      safeToRetryMail: false,
    });
    expect(h.logError).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'portal-inbox-reply-mail-journal', errorType: 'Error' }),
      'portal inbox reply saved but mail result could not be journaled',
    );
    expect(revalidatedPaths()).toEqual([...THREAD_PATHS, '/portal/inbox']);
  });
});
