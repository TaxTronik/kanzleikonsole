// Fachkatalog: PORTAL-INBOX-SUBMISSION-001, DOC-VERSION-IMMUTABILITY-001
// =============================================================================
// R-05: Der Anlagenabruf des Mandantenposteingangs (Portal und Staff) streamt
// über den gemeinsamen, prüfenden Leseweg (streamVerifiedObject). S3 ist am
// Storage-Client gemockt; Größen- und SHA-256-Prüfung laufen echt.
// =============================================================================

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ send: vi.fn(), audit: vi.fn() }));

vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_context: unknown, run: (tx: unknown) => unknown) => run({}),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: () => '192.0.2.10' }));
vi.mock('../access', () => ({
  assertActivePortalInboxIdentityTx: vi.fn(),
  assertStaffInboxClientTx: vi.fn(),
}));
vi.mock('@taxtronik/storage/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/storage/client')>()),
  s3: { send: h.send },
}));

import {
  buildInboxAttachmentDownloadResponse,
  type InboxAttachmentObject,
} from '../attachment-delivery';

const BYTES = Buffer.from('%PDF-1.7 Kontoauszug Mai');
const source: InboxAttachmentObject = {
  bucket: 'staging',
  key: 'tenants/tenant-1/none/2026/10/object-1.bin',
  storageVersionId: 'staging-version',
  sha256: createHash('sha256').update(BYTES).digest(),
  sizeBytes: BigInt(BYTES.length),
  mimeType: 'application/pdf',
  downloadName: 'Kontoauszug.pdf',
  audit: {
    context: { tenantId: 'tenant-1', actorId: 'contact-1', actorType: 'CLIENT_CONTACT' },
    actorType: 'CLIENT_CONTACT',
    actorId: 'contact-1',
    attachmentId: 'attachment-1',
    acceptedDocument: false,
  },
};
const request = { headers: new Headers({ 'user-agent': 'Inbox-Test' }) } as never;

function stored(bytes: Buffer, contentLength = bytes.length) {
  h.send.mockResolvedValueOnce({ Body: Readable.from([bytes]), ContentLength: contentLength });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue({});
});

describe('Posteingangsanlage über den geprüften Leseweg (R-05)', () => {
  it('liefert die Bytes der gebundenen Fassung nach Größen- und SHA-256-Prüfung', async () => {
    stored(BYTES);

    const response = await buildInboxAttachmentDownloadResponse(request, source);

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect((h.send.mock.calls[0]![0] as GetObjectCommand).input).toEqual({
      Bucket: 'staging',
      Key: source.key,
      VersionId: 'staging-version',
    });
  });

  it('bricht die Antwort bei abweichenden Bytes gleicher Länge ab', async () => {
    const tampered = Buffer.from(BYTES);
    tampered[tampered.length - 1] = 0x21;
    stored(tampered);

    const response = await buildInboxAttachmentDownloadResponse(request, source);

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'HASH_MISMATCH',
    });
  });

  it('öffnet bei abweichender angekündigter Länge keinen Stream und protokolliert nichts', async () => {
    stored(BYTES, BYTES.length + 1);

    await expect(buildInboxAttachmentDownloadResponse(request, source)).rejects.toMatchObject({
      name: 'StoredObjectError',
      reason: 'LENGTH_MISMATCH',
    });
    expect(h.audit).not.toHaveBeenCalled();
  });
});
