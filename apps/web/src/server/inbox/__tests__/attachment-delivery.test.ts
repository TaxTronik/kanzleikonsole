import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  streamObject: vi.fn(),
  withTenant: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('next/server', () => ({
  NextResponse: class NextResponse {
    static json(body: unknown, init?: { status?: number }) {
      return { body, status: init?.status ?? 200 };
    }

    constructor(
      readonly body: unknown,
      readonly init: unknown,
    ) {}
  },
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenant }));
vi.mock('@taxtronik/storage', () => ({
  sanitizeFilenameForHeader: (name: string) => name,
  streamObject: h.streamObject,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '192.0.2.10' }));
vi.mock('../access', () => ({
  assertActivePortalInboxIdentityTx: vi.fn(),
  assertStaffInboxClientTx: vi.fn(),
}));

import {
  buildInboxAttachmentDownloadResponse,
  portalInboxAttachmentDownloadResponse,
  staffInboxAttachmentDownloadResponse,
  type InboxAttachmentObject,
} from '../attachment-delivery';

// Fachkatalog: PORTAL-INBOX-SUBMISSION-001, AUDIT-HASH-CHAIN-001.

const source: InboxAttachmentObject = {
  bucket: 'staging',
  key: 'tenants/tenant-1/inbox/object-1',
  mimeType: 'application/pdf',
  downloadName: 'nicht-im-audit.pdf',
  audit: {
    context: { tenantId: 'tenant-1', actorId: 'contact-1', actorType: 'CLIENT_CONTACT' },
    actorType: 'CLIENT_CONTACT',
    actorId: 'contact-1',
    attachmentId: 'attachment-1',
    acceptedDocument: false,
  },
};

const request = {
  headers: new Headers({ 'user-agent': 'Inbox-Test' }),
} as never;

describe('Portal-Inbox Download-Audit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.withTenant.mockImplementation(async (_context, callback) => callback({}));
  });

  it.each(['portal', 'staff'])(
    'DOC-VERSION-IMMUTABILITY-001: akzeptierte Anlagen verwenden aktuelle Scanfreigabe und S3-Version (%s)',
    async (actor) => {
      const version = {
        storageBucket: 'gobd',
        storageKey: 'bound-key',
        storageVersionId: 'bound-version',
        scanStatus: 'CLEAN',
        scanCompletedAt: new Date(),
      };
      const attachment = {
        id: 'attachment-1',
        clientId: 'client-1',
        decision: 'ACCEPTED',
        acceptedDocument: {
          title: 'approved.pdf',
          mimeType: 'application/pdf',
          deletedAt: null,
          sharedWithClientAt: new Date(),
          versions: [version],
        },
      };
      const tx = { portalInboxAttachment: { findFirst: vi.fn(async () => attachment) } };
      h.withTenant.mockImplementation(async (_context, callback) => callback(tx));
      h.streamObject.mockResolvedValue({ body: new Uint8Array([1]), contentLength: 1 });
      const session = {
        user: {
          tenantId: 'tenant-1',
          clientId: 'client-1',
          contactId: 'contact-1',
          staffId: 'staff-1',
        },
      } as never;
      const download =
        actor === 'portal'
          ? portalInboxAttachmentDownloadResponse
          : staffInboxAttachmentDownloadResponse;
      await download(request, session, 'attachment-1');
      expect(h.streamObject).toHaveBeenCalledWith('gobd', 'bound-key', 'bound-version');
      h.streamObject.mockClear();
      h.audit.mockClear();
      version.scanStatus = 'INFECTED';
      const blocked = await download(request, session, 'attachment-1');
      expect(blocked.status).toBe(404);
      expect(h.streamObject).not.toHaveBeenCalled();
      expect(h.audit).not.toHaveBeenCalled();
    },
  );

  it('schreibt bei fehlendem Object-Open keinen falschen Downloadnachweis', async () => {
    h.streamObject.mockRejectedValueOnce(new Error('object missing'));

    await expect(buildInboxAttachmentDownloadResponse(request, source)).rejects.toThrow(
      'object missing',
    );
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('protokolliert erst den erfolgreich geöffneten Stream und keine Inhaltsmetadaten', async () => {
    h.streamObject.mockResolvedValueOnce({ body: new Uint8Array([1]), contentLength: 1 });

    await expect(buildInboxAttachmentDownloadResponse(request, source)).resolves.toBeTruthy();
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'portal_inbox.attachment_download_stream_opened',
        resourceId: 'attachment-1',
        after: { acceptedDocument: false },
      }),
    );
    const serialized = JSON.stringify(h.audit.mock.calls);
    expect(serialized).not.toContain(source.downloadName);
    expect(serialized).not.toContain(source.key);
  });
});
