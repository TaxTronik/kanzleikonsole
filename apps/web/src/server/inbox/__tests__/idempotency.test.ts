import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  assertPortal: vi.fn(),
  assertStaff: vi.fn(),
  eligible: vi.fn(),
  assignee: vi.fn(),
  recipients: vi.fn(),
  audit: vi.fn(),
  auditFind: vi.fn(),
}));

vi.mock('../access', () => ({
  assertActivePortalInboxIdentityTx: h.assertPortal,
  assertStaffInboxClientTx: h.assertStaff,
  eligibleInboxStaffIdsTx: h.eligible,
}));
vi.mock('../routing', () => ({
  resolveInboxAssigneeTx: h.assignee,
  resolveInboxNotificationRecipientsTx: h.recipients,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));

import { createPortalInboxThreadTx } from '../portal-mutations';
import { replyInboxThreadTx } from '../staff-mutations';

const actor = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  contactId: 'contact-1',
};
const mutationId = '00000000-0000-4000-8000-000000000001';

describe('PORTAL-INBOX-SUBMISSION-001 idempotente Doppel-Submits', () => {
  beforeEach(() => vi.resetAllMocks());

  it('serialisiert Portal-Writes vor dem Lookup und gibt den gespeicherten Erfolg zurück', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const findFirst = vi.fn().mockResolvedValue({
      id: 'message-1',
      body: 'Guten Tag',
      threadId: 'thread-1',
      thread: { subject: 'Frage', topic: 'GENERAL' },
    });
    const create = vi.fn();
    const tx = {
      $executeRaw: executeRaw,
      portalInboxMessage: { findFirst, create },
      auditLog: { findFirst: h.auditFind },
    };
    h.auditFind.mockResolvedValue({ after: { batchId: null } });

    await expect(
      createPortalInboxThreadTx(tx as never, actor, {
        subject: 'Frage',
        topic: 'GENERAL',
        body: 'Guten Tag',
        clientMutationId: mutationId,
      }),
    ).resolves.toEqual({ threadId: 'thread-1', messageId: 'message-1', idempotent: true });

    expect(executeRaw).toHaveBeenCalledOnce();
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findFirst.mock.invocationCallOrder[0]!,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('weist dieselbe Mutation-ID mit abweichendem Upload-Batch zurück', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      portalInboxMessage: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'message-1',
          body: 'Guten Tag',
          threadId: 'thread-1',
          thread: { subject: 'Frage', topic: 'GENERAL' },
        }),
        create: vi.fn(),
      },
      auditLog: { findFirst: h.auditFind },
    };
    h.auditFind.mockResolvedValue({ after: { batchId: 'batch-original' } });

    await expect(
      createPortalInboxThreadTx(tx as never, actor, {
        subject: 'Frage',
        topic: 'GENERAL',
        body: 'Guten Tag',
        clientMutationId: mutationId,
        batchId: 'batch-retry',
      }),
    ).rejects.toThrow('Wiederholungs-ID');

    expect(tx.portalInboxMessage.create).not.toHaveBeenCalled();
  });

  it('serialisiert Kanzleiantworten vor dem Lookup und versendet keine zweite Nachricht', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const findFirst = vi.fn().mockResolvedValue({
      id: 'message-staff-1',
      threadId: 'thread-1',
      clientId: 'client-1',
      body: 'Unsere Antwort',
    });
    const create = vi.fn();
    const tx = {
      $executeRaw: executeRaw,
      portalInboxMessage: { findFirst, create },
    };
    const session = {
      user: { tenantId: 'tenant-1', staffId: 'staff-1' },
    };

    await expect(
      replyInboxThreadTx(tx as never, session as never, {
        threadId: 'thread-1',
        body: 'Unsere Antwort',
        clientMutationId: mutationId,
      }),
    ).resolves.toEqual({
      messageId: 'message-staff-1',
      clientId: 'client-1',
      idempotent: true,
    });

    expect(executeRaw).toHaveBeenCalledOnce();
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findFirst.mock.invocationCallOrder[0]!,
    );
    expect(h.assertStaff).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});
