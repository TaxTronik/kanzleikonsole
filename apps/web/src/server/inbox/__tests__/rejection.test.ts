import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  assertStaff: vi.fn(),
  audit: vi.fn(),
  queryRaw: vi.fn(),
  attachmentFindFirst: vi.fn(),
  attachmentUpdate: vi.fn(),
}));

vi.mock('../access', () => ({
  assertStaffInboxClientTx: h.assertStaff,
  eligibleInboxStaffIdsTx: vi.fn(),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));

import { rejectInboxAttachmentTx } from '../staff-mutations';

const session = {
  user: { tenantId: 'tenant-1', staffId: 'staff-1' },
};

function transaction() {
  return {
    $queryRaw: h.queryRaw,
    portalInboxAttachment: {
      findFirst: h.attachmentFindFirst,
      update: h.attachmentUpdate,
    },
  };
}

describe('PORTAL-INBOX-SUBMISSION-001 / DOC-UPLOAD-JOURNAL-001 / DOC-VERSION-IMMUTABILITY-001 Inbox-Ablehnung', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.queryRaw
      .mockResolvedValueOnce([{ id: 'attachment-1', clientId: 'client-1' }])
      .mockResolvedValueOnce([{ rejected: true }]);
    h.attachmentFindFirst.mockResolvedValue({
      decision: 'PENDING_REVIEW',
      messageId: 'message-1',
      acceptedDocumentId: 'pending-document-1',
    });
  });

  it('bricht eine Resume-Reservierung nur über den atomaren DB-Fachpfad ab', async () => {
    const tx = transaction();

    await expect(
      rejectInboxAttachmentTx(tx as never, session as never, 'attachment-1', 'NOT_REQUIRED'),
    ).resolves.toEqual({ rejected: true });

    expect(h.assertStaff).toHaveBeenCalledWith(tx, session, 'client-1', {
      requireUpload: true,
    });
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
    expect(h.attachmentUpdate).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'portal_inbox.attachment_rejected',
        resourceId: 'attachment-1',
        after: {
          messageId: 'message-1',
          reason: 'NOT_REQUIRED',
          pendingAcceptanceAborted: true,
        },
      }),
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('pending-document-1');
  });

  it('protokolliert keinen Erfolg, wenn Scope-, Hash- oder Versionsguard den Abbruch verweigert', async () => {
    const tx = transaction();
    h.queryRaw.mockReset();
    h.queryRaw
      .mockResolvedValueOnce([{ id: 'attachment-1', clientId: 'client-1' }])
      .mockRejectedValueOnce(new Error('Reservierte Inbox-Version stimmt nicht ueberein.'));

    await expect(
      rejectInboxAttachmentTx(tx as never, session as never, 'attachment-1', 'OTHER'),
    ).rejects.toThrow('Reservierte Inbox-Version');

    expect(h.attachmentUpdate).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
