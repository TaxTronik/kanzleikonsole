// Fachkatalog: DOC-UPLOAD-JOURNAL-001
// Review-Finding K-06: Portal-Upload journalisiert die Speicherabsicht vor dem
// Object-Write und schliesst sie im Mandantenkontext atomar ab.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
  portalAuth: vi.fn(),
  withTenantContext: vi.fn(),
  readPortalFeaturesTx: vi.fn(),
  createDocumentWithVersion: vi.fn(),
  evidenceRecord: vi.fn(),
  emitN8nEvent: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'http://localhost:3000' }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: m.portalAuth }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => '127.0.0.1',
  checkPortalWriteLimit: async () => ({ ok: true }),
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    prepareBytesCommitWithTier: storageJournal.prepare,
    commitPreparedBytes: storageJournal.commit,
  };
});
vi.mock('@/server/db/prisma-owner', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return { prismaOwner: storageJournal.owner };
});
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: Uint8Array) => value }));
vi.mock('@/server/documents/upload-helpers', () => ({
  parseMultipartUpload: async (req: NextRequest) => {
    const form = await req.formData();
    return { ok: true, form, file: form.get('file') };
  },
  storageCommitErrorResponse: (error: unknown) =>
    NextResponse.json({ error: (error as Error).message }, { status: 422 }),
  createDocumentWithVersion: m.createDocumentWithVersion,
}));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeaturesTx: m.readPortalFeaturesTx,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: m.emitN8nEvent }));
vi.mock('@/server/logger', () => ({ log: m.log }));

import { POST } from '../commit/route';
import {
  processCrash,
  storageJournal,
  waitForEvent,
} from '@/server/documents/__tests__/storage-journal-fake';

const contexts: unknown[] = [];
const tx = { $executeRaw: storageJournal.executeRaw };

function request(content = 'Beleg vom Mandanten') {
  const form = new FormData();
  form.set('file', new Blob([content], { type: 'application/pdf' }), 'beleg.pdf');
  form.set('title', 'Beleg');
  form.set('mimeType', 'application/pdf');
  return new NextRequest('http://localhost:3000/api/portal/documents/commit', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  contexts.length = 0;
  m.portalAuth.mockResolvedValue({
    user: { tenantId: 'tenant-1', contactId: 'contact-1', clientId: 'client-1' },
  });
  m.readPortalFeaturesTx.mockResolvedValue({ documentUpload: true });
  m.withTenantContext.mockImplementation(async (ctx: unknown, fn: (value: unknown) => unknown) => {
    contexts.push(ctx);
    return fn(tx);
  });
  m.createDocumentWithVersion.mockResolvedValue({ document: { id: 'doc-1' } });
});

describe('POST /api/portal/documents/commit — Journal-first', () => {
  it('lehnt ein deaktiviertes Portal-Feature vor Scan, Journal und Object-Write ab', async () => {
    m.readPortalFeaturesTx.mockResolvedValue({ documentUpload: false });

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'feature_disabled' });
    expect(storageJournal.events).toEqual([]);
  });

  it('schliesst die Absicht im Mandantenkontext zusammen mit dem Dokument ab', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, documentId: 'doc-1' });
    expect(contexts).toEqual([
      { tenantId: 'tenant-1', actorId: 'contact-1', actorType: 'CLIENT_CONTACT' },
      { tenantId: 'tenant-1', actorId: 'contact-1', actorType: 'CLIENT_CONTACT' },
    ]);
    // Nachpruefung der Freigabe in der Commit-Transaktion.
    expect(m.readPortalFeaturesTx).toHaveBeenCalledTimes(2);
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({
        source: 'portal.document.commit',
        intent: true,
        immutable: false,
        storageBucket: 'bucket-none',
        resolution: 'REFERENCED',
      }),
    ]);
    expect(m.emitN8nEvent).toHaveBeenCalledTimes(1);
  });

  it('laesst die Absicht offen, wenn die Freigabe waehrend des Uploads entzogen wird', async () => {
    m.readPortalFeaturesTx
      .mockResolvedValueOnce({ documentUpload: true })
      .mockResolvedValueOnce({ documentUpload: false });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(m.createDocumentWithVersion).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({ storageVersionId: storageJournal.objects[0]!.versionId }),
    ]);
  });

  it('meldet einen gescheiterten DB-Commit ohne Rohtext und laesst die Absicht offen', async () => {
    m.createDocumentWithVersion.mockRejectedValue(new Error('connection reset by 10.0.0.5'));

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'database_commit_failed' });
    expect(storageJournal.openIntents()).toHaveLength(1);
    expect(storageJournal.events).not.toContain('compensate');
  });

  // K-06: Prozessabbruch zwischen Object-Write und DB-Commit (Portal-Familie).
  it('hinterlaesst nach einem Abbruch zwischen PUT und DB-Commit eine aufloesbare Speicherabsicht', async () => {
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (value: unknown) => unknown) => fn(tx))
      .mockImplementationOnce(() => processCrash());

    void POST(request());
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(intent).toMatchObject({
      tenantId: 'tenant-1',
      source: 'portal.document.commit',
      storageVersionId: '',
      immutable: false,
    });
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
  });
});
