// Fachkatalog: DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const TYPE_ID = '33333333-3333-4333-8333-333333333333';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  canAccessClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  prepare: vi.fn(),
  evidenceRecord: vi.fn(),
  getClientIp: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@taxtronik/config', () => ({
  env: { NEXTAUTH_URL: 'http://localhost:3000' },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: m.canAccessClientTx }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    classificationToTier: (classification: string) =>
      classification === 'GENERAL' ? 'NONE' : 'GOBD',
    gobdRetentionYears: () => 10,
    prepareBytesCommitWithTier: m.prepare,
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
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'file_missing' }, { status: 400 }),
      };
    }
    return { ok: true, form, file };
  },
  storageCommitErrorResponse: (error: unknown) =>
    NextResponse.json({ error: (error as Error).message }, { status: 500 }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: m.getClientIp }));
vi.mock('@/server/logger', () => ({ log: m.log }));

import { POST } from '../route';
import {
  processCrash,
  storageJournal,
  waitForEvent,
} from '@/server/documents/__tests__/storage-journal-fake';

interface DocumentRow {
  classification: string;
  documentTypeId: string | null;
  clientId?: string | null;
  lockedByGwg?: boolean;
}

/** Transaktion mit Dokument-/Typzeile (beide Phasen sperren dieselben Zeilen). */
function documentTx(
  document: DocumentRow | null,
  options: {
    type?: { tier: string; retentionYears: number | null } | null;
    poa?: { id: string } | null;
  } = {},
) {
  return {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (sql.includes('FROM document_type')) {
        return options.type ? [{ id: document?.documentTypeId, ...options.type }] : [];
      }
      // F-03: GwG-Zuordnung als eigenes Statement nach der Dokumentsperre.
      if (sql.includes('FROM gwg_id_document')) {
        return [{ assigned: document?.lockedByGwg === true }];
      }
      if (!document) return [];
      const { lockedByGwg: _assigned, ...row } = document;
      return [{ id: DOCUMENT_ID, tenantId: 'tenant-1', clientId: CLIENT_ID, ...row }];
    }),
    $executeRaw: storageJournal.executeRaw,
    powerOfAttorney: { findFirst: vi.fn().mockResolvedValue(options.poa ?? null) },
    documentVersion: {
      findFirst: vi.fn().mockResolvedValue({ versionNo: 1 }),
      create: vi.fn().mockResolvedValue({ id: 'version-2' }),
    },
    document: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

function phases(pre: unknown, post: unknown) {
  m.withTenantContext
    .mockImplementationOnce(async (_ctx: unknown, fn: (arg: unknown) => unknown) => fn(pre))
    .mockImplementationOnce(async (_ctx: unknown, fn: (arg: unknown) => unknown) => fn(post));
}

function makeRequest() {
  const form = new FormData();
  form.set('file', new Blob(['neue Version'], { type: 'application/pdf' }), 'vollmacht.pdf');
  form.set('mimeType', 'application/pdf');
  return new NextRequest(
    `http://localhost:3000/api/staff/documents/${DOCUMENT_ID}/new-version/commit`,
    {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
      body: form,
    },
  );
}

const post = () => POST(makeRequest(), { params: Promise.resolve({ id: DOCUMENT_ID }) });
const puts = () => storageJournal.events.filter((event) => event.startsWith('put:')).length;

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  m.prepare.mockImplementation(storageJournal.prepare);
  m.staffAuth.mockResolvedValue({
    user: { tenantId: 'tenant-1', staffId: 'staff-1' },
  });
  m.canAccessClientTx.mockResolvedValue(true);
});

describe('Neue Dokumentversion — PoA-Snapshot-Sperre', () => {
  it('liefert 404 ohne Storage-Upload, wenn das Dokument nicht (mehr) existiert', async () => {
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
      fn(documentTx(null)),
    );

    const response = await post();

    expect(response.status).toBe(404);
    expect(storageJournal.events).toEqual([]);
  });

  it('sperrt bereits zugeordnete GwG-Belege vor dem Storage-Upload', async () => {
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
      fn(documentTx({ classification: 'GWG_EVIDENCE', documentTypeId: null, lockedByGwg: true })),
    );

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'locked_by_gwg_snapshot' }),
    );
    expect(storageJournal.events).toEqual([]);
  });

  it('verhindert auch eine GwG-Zuordnung zwischen Vorpruefung und Versionsinsert', async () => {
    const finalTx = documentTx({
      classification: 'GWG_EVIDENCE',
      documentTypeId: null,
      lockedByGwg: true,
    });
    phases(documentTx({ classification: 'GWG_EVIDENCE', documentTypeId: null }), finalTx);

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'locked_by_gwg_snapshot' }),
    );
    expect(finalTx.documentVersion.create).not.toHaveBeenCalled();
    // F-03: Die Nachprüfung erkennt die Zuordnung selbst — in einem eigenen
    // Statement nach der Dokumentsperre, nicht am Meldungstext des Triggers.
    const statements = finalTx.$queryRaw.mock.calls.map(([strings]) => strings.join(' '));
    expect(statements[0]).toContain('FOR UPDATE OF d');
    expect(statements[1]).toContain('FROM gwg_id_document');
    // K-06: kein nachgelagertes Orphan-Journal; die Vorab-Absicht bleibt offen.
    expect(storageJournal.events).not.toContain('compensate');
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-1',
        source: 'staff.document.new_version',
        storageVersionId: storageJournal.objects[0]!.versionId,
      }),
    ]);
  });

  it('ordnet den Meldungstext des GwG-Triggers ohne Fehlerklasse nicht als Sperre ein', async () => {
    const finalTx = documentTx({ classification: 'GWG_EVIDENCE', documentTypeId: null });
    finalTx.documentVersion.create.mockRejectedValueOnce(
      new Error(
        'Zugeordneter GwG-Beweisinhalt ist unveraenderlich; neues Dokument anlegen und erneut zuordnen.',
      ),
    );
    phases(documentTx({ classification: 'GWG_EVIDENCE', documentTypeId: null }), finalTx);

    const response = await post();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'internal_error' });
    expect(storageJournal.openIntents()).toHaveLength(1);
  });

  it('sperrt bereits ab SENT und lädt keine neuen Bytes in den Speicher', async () => {
    const tx = documentTx(
      { classification: 'GOBD_CONTRACT', documentTypeId: null },
      { poa: { id: 'poa-1' } },
    );
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
      fn(tx),
    );

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'locked_by_poa' }),
    );
    expect(tx.powerOfAttorney.findFirst).toHaveBeenCalledWith({
      where: {
        documentId: DOCUMENT_ID,
        OR: [{ status: { in: ['SENT', 'SIGNED'] } }, { signingContentSnapshot: { not: null } }],
      },
      select: { id: true },
    });
    expect(storageJournal.events).toEqual([]);
  });

  it('verhindert auch das Rennen Versand zwischen Vorprüfung und Versionsinsert', async () => {
    const finalTx = documentTx(
      { classification: 'GOBD_CONTRACT', documentTypeId: null },
      { poa: { id: 'poa-1' } },
    );
    phases(documentTx({ classification: 'GOBD_CONTRACT', documentTypeId: null }), finalTx);

    const response = await post();

    expect(response.status).toBe(409);
    expect(puts()).toBe(1);
    expect(finalTx.documentVersion.create).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({ source: 'staff.document.new_version', immutable: true }),
    ]);
  });

  it('verhindert das Anhaengen nach zwischenzeitlichem Entzug des Mandantenzugriffs', async () => {
    const finalTx = documentTx({ classification: 'GENERAL', documentTypeId: null });
    phases(documentTx({ classification: 'GENERAL', documentTypeId: null }), finalTx);
    m.canAccessClientTx.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'reference_changed' }),
    );
    expect(finalTx.documentVersion.create).not.toHaveBeenCalled();
    expect(m.canAccessClientTx).toHaveBeenCalledTimes(2);
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({ immutable: false, storageBucket: 'bucket-none' }),
    ]);
  });

  it('verwirft den Upload, wenn sich die Schutzpolicy des Dateityps geaendert hat', async () => {
    const document = { classification: 'GOBD_INVOICE', documentTypeId: TYPE_ID };
    const finalTx = documentTx(document, { type: { tier: 'GOBD', retentionYears: 6 } });
    phases(documentTx(document, { type: { tier: 'GOBD', retentionYears: 8 } }), finalTx);

    const response = await post();

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: 'reference_changed' }),
    );
    expect(finalTx.documentVersion.create).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toHaveLength(1);
  });

  it('übernimmt typabhängige Frist und verlängert Document-Metadaten monoton', async () => {
    const document = { classification: 'GOBD_INVOICE', documentTypeId: TYPE_ID };
    const type = { tier: 'GOBD', retentionYears: 8 };
    const finalTx = documentTx(document, { type });
    phases(documentTx(document, { type }), finalTx);

    const response = await post();

    expect(response.status).toBe(200);
    expect(m.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'GOBD',
        classification: 'GOBD_INVOICE',
        retentionYears: 8,
      }),
    );
    const retentionUntil = storageJournal.objects[0]!.retainUntil!;
    expect(finalTx.document.updateMany).toHaveBeenCalledWith({
      where: {
        id: DOCUMENT_ID,
        OR: [{ retentionUntil: null }, { retentionUntil: { lt: retentionUntil } }],
      },
      data: { retentionUntil },
    });
    expect(finalTx.documentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        versionNo: 2,
        storageKey: storageJournal.objects[0]!.key,
        storageVersionId: storageJournal.objects[0]!.versionId,
      }),
    });
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({ resolution: 'REFERENCED', cleanedAt: expect.any(Date) }),
    ]);
  });

  // K-06: Prozessabbruch zwischen Object-Write und Versionsinsert.
  it('hinterlaesst nach einem Abbruch zwischen PUT und DB-Commit eine aufloesbare Speicherabsicht', async () => {
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (arg: unknown) => unknown) =>
        fn(documentTx({ classification: 'GOBD_CONTRACT', documentTypeId: null })),
      )
      .mockImplementationOnce(() => processCrash());

    void post();
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(intent).toMatchObject({ source: 'staff.document.new_version', storageVersionId: '' });
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
  });
});
