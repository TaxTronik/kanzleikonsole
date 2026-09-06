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
