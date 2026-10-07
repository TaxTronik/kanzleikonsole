// Fachkatalog: PORTAL-INBOX-SUBMISSION-001, DOC-UPLOAD-JOURNAL-001
// =============================================================================
// F-03: Der Anlagen-Upload des Mandantenposteingangs ordnet Ablehnungen des
// Storage-Pakets über Fehlerklasse und `reason` ein (UploadRejectedError,
// StoredObjectError), nicht über den Meldungstext. Antworten und Statuscodes
// bleiben unverändert; ein Fremdfehler mit passendem Meldungspräfix wird nicht
// mehr als Ablehnung ausgegeben.
// =============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StoredObjectError, UploadRejectedError } from '@taxtronik/storage/errors';

const h = vi.hoisted(() => ({ stage: vi.fn(), logError: vi.fn() }));

vi.mock('@taxtronik/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxtronik/config')>()),
  portalBaseUrl: 'http://localhost:3001',
}));
vi.mock('@/server/auth/portal', () => ({
  portalAuth: async () => ({
    user: { tenantId: 'tenant-1', clientId: 'client-1', contactId: 'contact-1' },
  }),
}));
vi.mock('@/server/http/assert-same-origin', () => ({ assertSameOrigin: () => null }));
vi.mock('@/server/rate-limit', () => ({
  checkPortalWriteLimit: async () => ({ ok: true }),
  checkPortalInboxUploadLimit: async () => ({ ok: true }),
}));
vi.mock('@/server/documents/upload-helpers', () => ({
  parseMultipartUpload: async () => {
    const form = new FormData();
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'beleg.pdf');
    form.set('file', file);
    return { ok: true, form, file };
  },
}));
vi.mock('@/server/logger', () => ({ log: { error: h.logError } }));
// Echte Fehlerklassen des Staging-Moduls; nur der Upload selbst ist ersetzt.
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/documents/storage-compensation', () => ({ compensateStorageCommit: vi.fn() }));
vi.mock('@/server/inbox/access', () => ({ assertActivePortalInboxIdentityTx: vi.fn() }));
vi.mock('@/server/inbox/staging-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/inbox/staging-upload')>()),
  stageInboxAttachment: h.stage,
}));

import { InboxUploadError, InboxUploadPolicyError } from '@/server/inbox/staging-upload';
import { POST } from '../route';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';

async function upload(): Promise<NextResponse> {
  return POST(
    new NextRequest(`http://localhost:3001/api/portal/inbox/batches/${BATCH_ID}/files`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: BATCH_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Posteingang-Upload: Fehlerabbildung nach Fehlerklasse (F-03)', () => {
  it.each([
    [
      'infizierte Datei',
      new InboxUploadError('prepare', new UploadRejectedError('INFECTED', 'infiziert')),
      422,
      { error: 'file_blocked' },
    ],
    [
      'zu große Datei',
      new InboxUploadError('prepare', new UploadRejectedError('TOO_LARGE', 'zu groß')),
      413,
      { error: 'upload_limit' },
    ],
    [
      'zu großes Objekt beim Wiederaufnehmen',
      new InboxUploadError(
        'commit',
        new StoredObjectError('TOO_LARGE', 'Objekt überschreitet das Limit.'),
        'attachment-1',
      ),
      413,
      { error: 'upload_limit', retryable: true, attachmentId: 'attachment-1' },
    ],
    [
      'nicht verfügbarer Virenscan',
      new InboxUploadError(
        'commit',
        new UploadRejectedError('SCAN_ERROR', 'ClamAV-Scan fehlgeschlagen.'),
        'attachment-1',
      ),
      503,
      { error: 'scan_unavailable', retryable: true, attachmentId: 'attachment-1' },
    ],
    [
      'Mengenlimit des Stapels',
      new InboxUploadError('prepare', new InboxUploadPolicyError('LIMIT')),
      413,
      { error: 'upload_limit' },
    ],
  ])('%s → %i', async (_case, error, status, body) => {
    h.stage.mockRejectedValueOnce(error);

    const response = await upload();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual(body);
    expect(h.logError).not.toHaveBeenCalled();
  });

  it.each(['TOO_LARGE: Fremdtext', 'INFECTED: Fremdtext', 'SCAN_ERROR: Fremdtext'])(
    'ordnet einen Fremdfehler „%s“ nicht nach seinem Meldungstext ein',
    async (message) => {
      h.stage.mockRejectedValueOnce(new InboxUploadError('prepare', new Error(message)));

      const response = await upload();

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'upload_failed' });
      expect(h.logError).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'portal-inbox-upload', phase: 'prepare' }),
        'portal inbox upload failed',
      );
    },
  );
});
