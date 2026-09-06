import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetchBytes: vi.fn(),
  withTenant: vi.fn(),
  persist: vi.fn(),
  assertStaff: vi.fn(),
  carrier: vi.fn(),
  audit: vi.fn(),
  queryRaw: vi.fn(),
  attachmentFindFirst: vi.fn(),
  attachmentUpdateMany: vi.fn(),
  documentTypeFindFirst: vi.fn(),
  documentUpdate: vi.fn(),
}));

vi.mock('@taxtronik/storage', () => ({ fetchObjectBytes: h.fetchBytes }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenant }));
vi.mock('@/server/documents/resumable-upload', () => ({
  persistResumableDocumentUpload: h.persist,
}));
vi.mock('../access', () => ({ assertStaffInboxClientTx: h.assertStaff }));
vi.mock('@/server/storage/document-type', () => ({ carrierClassification: h.carrier }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));

import { acceptInboxAttachment } from '../accept-attachment';

const bytes = Buffer.from('%PDF-1.7\nclean');
const digest = createHash('sha256').update(bytes).digest();
const source = {
  id: 'attachment-1',
  clientId: 'client-1',
  messageId: 'message-1',
  mimeType: 'application/pdf',
  storageBucket: 'staging',
  storageKey: 'tenants/tenant-1/inbox/key-1',
  storageVersionId: 'staging-v1',
  sha256: new Uint8Array(digest),
  sizeBytes: BigInt(bytes.length),
  decision: 'PENDING_REVIEW',
  acceptedDocumentId: null,
  acceptedDocument: null,
};
const documentType = {
  id: 'type-1',
  tier: 'GOBD',
  classificationKey: 'GOBD_TAX',
  retentionYears: 10,
};

describe('DOC-PORTAL-SHARING-001 / DOC-UPLOAD-JOURNAL-001 Inbox-Annahme', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const tx = {
      $queryRaw: h.queryRaw,
      portalInboxAttachment: {
        findFirst: h.attachmentFindFirst,
        updateMany: h.attachmentUpdateMany,
      },
      documentType: { findFirst: h.documentTypeFindFirst },
      document: { update: h.documentUpdate },
    };
    h.withTenant.mockImplementation(async (_context, callback) => callback(tx));
    h.queryRaw.mockResolvedValue([{ id: 'attachment-1', clientId: 'client-1' }]);
    h.attachmentFindFirst.mockImplementation(async (args) => {
      if (args.where.messageId?.not === null) return source;
      if (args.where.acceptedDocumentId === 'document-1' && args.where.id?.not) return null;
      return { id: 'attachment-1' };
    });
    h.attachmentUpdateMany.mockResolvedValue({ count: 1 });
    h.documentTypeFindFirst.mockResolvedValue(documentType);
    h.documentUpdate.mockResolvedValue({ id: 'document-1' });
    h.fetchBytes.mockResolvedValue(bytes);
    h.carrier.mockReturnValue('GOBD_TAX');
    h.persist.mockImplementation(async (options) => {
      await options.readBytes();
      await options.guardMutationTx(tx);
      await options.assertDocumentAvailableTx(tx, 'document-1');
      await options.recordPendingTx(tx, { documentId: 'document-1', versionId: 'version-1' });
      await options.recordCompleteTx(tx, { documentId: 'document-1', versionId: 'version-1' });
      return { documentId: 'document-1', versionId: 'version-1', source: 'created' };
    });
  });

  it('leitet Schutz und Retention nur aus dem aktiven Typ ab und teilt erst nach Finalisierung', async () => {
    const context = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const };
    const session = { user: { tenantId: 'tenant-1', staffId: 'staff-1' } };

    await expect(
      acceptInboxAttachment({
        context,
        session: session as never,
        attachmentId: 'attachment-1',
        title: 'Steuerunterlagen 2025',
        documentTypeId: 'type-1',
      }),
    ).resolves.toMatchObject({
      attachmentId: 'attachment-1',
      documentId: 'document-1',
      alreadyAccepted: false,
    });

    expect(h.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        documentData: expect.objectContaining({
          title: 'Steuerunterlagen 2025',
          documentTypeId: 'type-1',
          classification: 'GOBD_TAX',
          sharedWithClientAt: null,
          sharedByStaff: null,
        }),
        storage: expect.objectContaining({
          tier: 'GOBD',
          classification: 'GOBD_TAX',
          retentionYears: 10,
        }),
      }),
    );
    expect(h.documentUpdate).toHaveBeenCalledWith({
      where: { id: 'document-1' },
      data: {
        sharedWithClientAt: expect.any(Date),
        sharedByStaff: 'staff-1',
      },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'portal_inbox.attachment_accepted',
        after: expect.objectContaining({
          sharedWithClient: true,
        }),
      }),
    );
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(digest.toString('hex'));
  });
});
