// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Upload einer Wissensanlage als Verhaltenstest des Route-Handlers (B-08,
// Welle 15) statt Quelltextprüfung: Modulschranke, begrenzter Multipart-Parser,
// zweiphasiger Journal-Upload und Ablage als allgemeines Dokument.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournaledUploadOptions } from '@/server/documents/journaled-upload';

const DRAFT = '11111111-1111-4111-8111-111111111111';
const ARTICLE = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  parse: vi.fn(),
  run: vi.fn(),
  createDocument: vi.fn(),
  record: vi.fn(),
  sameOrigin: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({ env: { NEXTAUTH_URL: 'https://kanzlei.example' } }));
vi.mock('@/server/http/assert-same-origin', () => ({ assertSameOrigin: h.sameOrigin }));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: h.guard }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@/server/documents/upload-helpers', () => ({
  parseMultipartUpload: h.parse,
  createDocumentWithVersion: h.createDocument,
  storageCommitErrorResponse: vi.fn(),
}));
vi.mock('@/server/documents/journaled-upload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/documents/journaled-upload')>()),
  runJournaledUpload: h.run,
}));

import { JournaledUploadError } from '@/server/documents/journaled-upload';
import { POST } from '../route';

const CTX = { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' };

function request() {
  return new NextRequest('https://kanzlei.example/api/staff/knowledge/attachments', {
    method: 'POST',
  });
}

function upload(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  h.parse.mockResolvedValue({
    ok: true,
    form,
    file: new File(['%PDF-1.7'], 'hilfe.pdf', { type: 'application/pdf' }),
  });
}

function tx() {
  return {
    kbArticle: { findFirst: vi.fn(async () => ({ id: ARTICLE })) },
    documentType: { findFirst: vi.fn(async () => ({ id: 'type-general' })) },
    kbAttachment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'attachment-1',
        ...data,
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sameOrigin.mockReturnValue(null);
  h.guard.mockResolvedValue({ ok: true, tenantId: 'tenant-1', staffId: 'staff-1', ctx: CTX });
  h.createDocument.mockResolvedValue({ document: { id: 'document-1' } });
  upload({ draftToken: DRAFT, articleId: ARTICLE, displayName: 'Arbeitshilfe' });
});

describe('Wissensanhänge: Upload', () => {
  it('nutzt die begrenzte, geprüfte Dokumentablage mit Vorab-Journal', async () => {
    let options!: JournaledUploadOptions<{ documentTypeId: string | null }, unknown>;
    const transaction = tx();
    h.run.mockImplementation(async (received) => {
      options = received;
      const checked = await received.check(transaction, 'pre');
      const result = await received.commitTx(transaction, {
        checked,
        commit: { detectedMime: 'application/pdf', sha256: Buffer.alloc(32, 1) },
      });
      return { result };
    });
    const req = request();
    const response = await POST(req);

    expect(h.guard).toHaveBeenCalledExactlyOnceWith({ module: 'knowledge' });
    expect(h.parse).toHaveBeenCalledExactlyOnceWith(req);
    expect(options.context).toBe(CTX);
    expect(options.source).toBe('knowledge.attachment.upload');
    expect(options.storage({ documentTypeId: 'type-general' })).toEqual({
      tier: 'NONE',
      classification: 'GENERAL',
    });
    expect(transaction.kbArticle.findFirst).toHaveBeenCalledWith({
      where: { id: ARTICLE, tenantId: 'tenant-1' },
      select: { id: true },
    });
    expect(h.createDocument.mock.calls[0]![1].documentData).toMatchObject({
      tenantId: 'tenant-1',
      clientId: null,
      classification: 'GENERAL',
      documentTypeId: 'type-general',
      mimeType: 'application/pdf',
    });
    expect(transaction.kbAttachment.create.mock.calls[0]![0].data).toMatchObject({
      draftToken: DRAFT,
      articleId: ARTICLE,
      uploadedBy: 'staff-1',
    });
    expect(await response.json()).toEqual({
      ok: true,
      attachment: {
        id: 'attachment-1',
        displayName: 'Arbeitshilfe',
        mimeType: 'application/pdf',
      },
    });
  });

  it('weist Uploads ohne Modulrecht vor dem Parsen ab', async () => {
    h.guard.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(h.parse).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it('meldet einen fremden oder fehlenden Artikel aus der Vorprüfung als 404', async () => {
    const transaction = tx();
    transaction.kbArticle.findFirst.mockResolvedValueOnce(null as never);
    h.run.mockImplementation(async (received) => {
      try {
        await received.check(transaction, 'pre');
      } catch (cause) {
        throw new JournaledUploadError('check', cause);
      }
      throw new Error('unerwartet');
    });
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'article_not_found' });
    expect(h.createDocument).not.toHaveBeenCalled();
  });
});
