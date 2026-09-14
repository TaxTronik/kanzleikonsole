import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  withTenant: vi.fn(),
  createThread: vi.fn(),
  addMessage: vi.fn(),
  writeLimit: vi.fn(),
  threadLimit: vi.fn(),
  revalidate: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidate }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenant }));
vi.mock('@/server/actions/portal-action', async () => {
  const { parseFormData } = await import('@/server/actions/form-data');
  return { parseFormData, portalActionGuard: h.guard };
});
vi.mock('@/server/rate-limit', () => ({
  checkPortalWriteLimit: h.writeLimit,
  checkPortalInboxThreadLimit: h.threadLimit,
}));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler',
  }),
}));
vi.mock('@/server/inbox/portal-mutations', () => ({
  createPortalInboxThreadTx: h.createThread,
  addPortalInboxMessageTx: h.addMessage,
  createPortalInboxUploadBatchTx: vi.fn(),
  discardPortalInboxUploadBatchTx: vi.fn(),
  markPortalInboxThreadReadTx: h.markRead,
}));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: vi.fn(),
}));

import {
  addInboxMessageAction,
  createInboxThreadAction,
  markInboxThreadReadAction,
} from '../actions';

const MUTATION_ID = '00000000-0000-4000-8000-000000000001';

function baseForm(): FormData {
  const form = new FormData();
  form.set('body', 'Guten Tag');
  form.set('clientMutationId', MUTATION_ID);
  return form;
}

describe('PORTAL-INBOX-SUBMISSION-001 Action-Vertrag ohne Anlagen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.guard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      clientId: 'client-1',
      contactId: 'contact-1',
      ctx: { tenantId: 'tenant-1', actorId: 'contact-1', actorType: 'CLIENT_CONTACT' },
    });
    h.writeLimit.mockResolvedValue({ ok: true });
    h.threadLimit.mockResolvedValue({ ok: true });
    h.withTenant.mockImplementation(async (_ctx, callback) => callback({}));
  });

  it('legt einen Verlauf an, wenn das optionale batchId-Feld vollständig fehlt', async () => {
    const form = baseForm();
    form.set('subject', 'Eine Frage');
    form.set('topic', 'GENERAL');
    h.createThread.mockResolvedValue({
      threadId: 'thread-1',
      messageId: 'message-1',
      idempotent: false,
    });

    await expect(createInboxThreadAction(form)).resolves.toMatchObject({
      ok: true,
      threadId: 'thread-1',
    });
    expect(h.createThread).toHaveBeenCalledOnce();
    expect(h.createThread.mock.calls[0]![2]).not.toHaveProperty('batchId');
  });

  it('antwortet ohne Anlagen, wenn batchId vollständig fehlt', async () => {
    const form = baseForm();
    form.set('threadId', '00000000-0000-4000-8000-000000000002');
    h.addMessage.mockResolvedValue({
      threadId: 'thread-1',
      messageId: 'message-2',
      idempotent: false,
    });

    await expect(addInboxMessageAction(form)).resolves.toMatchObject({
      ok: true,
      threadId: 'thread-1',
    });
    expect(h.addMessage).toHaveBeenCalledOnce();
    expect(h.addMessage.mock.calls[0]![2]).not.toHaveProperty('batchId');
  });

  it('übergibt den angezeigten Nachrichtenstand und die authentifizierte Identität', async () => {
    const form = new FormData();
    form.set('id', MUTATION_ID);
    form.set('lastMessageAt', '2026-09-14T00:00:00.000Z');

    await expect(markInboxThreadReadAction(form)).resolves.toEqual({ ok: true });
    expect(h.markRead).toHaveBeenCalledWith(
      {},
      { tenantId: 'tenant-1', clientId: 'client-1', contactId: 'contact-1' },
      MUTATION_ID,
      new Date('2026-09-14T00:00:00.000Z'),
    );
  });

  it.each([undefined, '', 'ungueltig', '2026-09-14', '2026-02-30T00:00:00Z'])(
    'weist einen fehlenden oder ungültigen angezeigten Stand vor Nebenwirkungen ab (%s)',
    async (value) => {
      const form = new FormData();
      form.set('id', MUTATION_ID);
      if (value !== undefined) form.set('lastMessageAt', value);

      await expect(markInboxThreadReadAction(form)).resolves.toMatchObject({
        ok: false,
        errorCode: 'VALIDATION_ERROR',
      });
      expect(h.guard).not.toHaveBeenCalled();
      expect(h.withTenant).not.toHaveBeenCalled();
      expect(h.markRead).not.toHaveBeenCalled();
    },
  );
});
