// Fachkatalog: DOC-UPLOAD-JOURNAL-001
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument } from 'pdf-lib';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  canAccessClientTx: vi.fn(),
  withTenantContext: vi.fn(),
  classificationToTier: vi.fn(),
  prepare: vi.fn(),
  createDocumentWithVersion: vi.fn(),
  evidenceRecord: vi.fn(),
  emitN8nEvent: vi.fn(),
  getClientIp: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@taxtronik/config', () => ({
  env: { NEXTAUTH_URL: 'http://localhost:3000' },
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({
  canAccessClientTx: m.canAccessClientTx,
  assertClientAccessTx: vi.fn(),
  ForbiddenError: class extends Error {},
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: m.withTenantContext,
  DEFAULT_BOOLEAN_TENANT_MODULES: {},
  parseBooleanTenantModules: () => ({}),
}));
vi.mock('@taxtronik/storage', async () => {
  const { storageJournal } = await import('@/server/documents/__tests__/storage-journal-fake');
  return {
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    classificationToTier: m.classificationToTier,
    isGobdClassification: () => false,
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
  storageCommitErrorResponse: (e: unknown) =>
    NextResponse.json({ error: (e as Error).message }, { status: 500 }),
  createDocumentWithVersion: m.createDocumentWithVersion,
}));
vi.mock('@/server/storage/document-type', () => ({
  carrierClassification: (_tier: string, classificationKey: string | null) =>
    classificationKey ?? 'GENERAL',
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: m.emitN8nEvent }));
vi.mock('@/server/rate-limit', () => ({ getClientIp: m.getClientIp }));
vi.mock('@/server/logger', () => ({ log: m.log }));

import { POST } from '../route';
import {
  processCrash,
  storageJournal,
  waitForEvent,
} from '@/server/documents/__tests__/storage-journal-fake';

const SESSION = {
  user: {
    tenantId: 'tenant-1',
    staffId: 'staff-1',
  },
};

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const DOCUMENT_TYPE_ID = '22222222-2222-4222-8222-222222222222';

function makeRequest(reminderId?: string) {
  const fd = new FormData();
  fd.set('file', new Blob(['vertrag'], { type: 'text/plain' }), 'vertrag.txt');
  fd.set('title', 'Vertrag');
  fd.set('documentTypeId', DOCUMENT_TYPE_ID);
  fd.set('clientId', CLIENT_ID);
  if (reminderId) fd.set('reminderId', reminderId);

  return new NextRequest('http://localhost:3000/api/staff/documents/commit', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
    body: fd,
  });
}

function makeClassificationRequest() {
  const fd = new FormData();
  fd.set('file', new Blob(['rechnung'], { type: 'text/plain' }), 'rechnung.txt');
  fd.set('title', 'Rechnung');
  fd.set('classification', 'GOBD_INVOICE');

  return new NextRequest('http://localhost:3000/api/staff/documents/commit', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
    body: fd,
  });
}

/** Commit-Transaktion: schliesst die Speicherabsicht ueber das Journal-Double ab. */
function commitTx(extra: Record<string, unknown> = {}) {
  return { $executeRaw: storageJournal.executeRaw, ...extra };
}

function gobdTypeTx() {
  return {
    documentType: {
      findFirst: vi.fn().mockResolvedValue({
        id: DOCUMENT_TYPE_ID,
        tier: 'GOBD',
        classificationKey: 'GOBD_INVOICE',
        retentionYears: 8,
      }),
    },
    client: { findFirst: vi.fn().mockResolvedValue({ id: CLIENT_ID }) },
    riskAnalysis: { findFirst: vi.fn() },
    workflowItem: { findFirst: vi.fn() },
    documentFolder: { findFirst: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storageJournal.reset();
  m.prepare.mockImplementation(storageJournal.prepare);
  m.staffAuth.mockResolvedValue(SESSION);
  m.canAccessClientTx.mockResolvedValue(true);
  m.classificationToTier.mockReturnValue('NONE');
  m.getClientIp.mockReturnValue('127.0.0.1');
});

describe('POST /api/staff/documents/commit - TOCTOU', () => {
  it('behandelt auch nicht typisierte Vorprüfungsfehler ohne Details oder Store-Write', async () => {
    m.withTenantContext.mockRejectedValueOnce(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal_error' });
    expect(storageJournal.events).toEqual([]);
  });

  // F-03: Ablehnungen der Vorprüfung über die Fehlerklasse, nicht über Meldungspräfixe.
  it('meldet eine Ablehnung der Vorprüfung mit unveränderter Meldung und ohne Store-Write', async () => {
    const tx = { ...gobdTypeTx(), client: { findFirst: vi.fn().mockResolvedValue(null) } };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'CLIENT_NOT_FOUND: clientId nicht in diesem Tenant.',
    });
    expect(storageJournal.events).toEqual([]);
  });

  it('reicht einen fremden Fehler mit Validierungspräfix nicht als Ablehnung ins UI', async () => {
    const tx = {
      ...gobdTypeTx(),
      client: {
        findFirst: vi.fn().mockRejectedValue(new Error('CLIENT_NOT_FOUND: interner Treibertext')),
      },
    };
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(tx),
    );

    const res = await POST(makeRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal_error' });
    expect(m.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'CLIENT_NOT_FOUND: interner Treibertext' }),
      expect.any(String),
    );
    expect(storageJournal.events).toEqual([]);
  });

  // Fachkatalog: REMINDER-TICKET-001
  it.each(['before-storage', 'during-storage'])(
    'archiviertes Ticket erhält keinen Anhang: %s',
    async (phase) => {
      const reminderId = '44444444-4444-4444-8444-444444444444';
      const tx = commitTx({
        $queryRaw: vi.fn().mockResolvedValue([{ id: reminderId }]),
        documentType: {
          findFirst: vi.fn().mockResolvedValue({
            id: DOCUMENT_TYPE_ID,
            tier: 'NONE',
            classificationKey: 'GENERAL',
            retentionYears: null,
          }),
        },
        client: { findFirst: vi.fn().mockResolvedValue({ id: CLIENT_ID }) },
        clientReminder: { findFirst: vi.fn() },
      });
      const reminder = {
        clientId: CLIENT_ID,
        createdByStaff: 'staff-1',
        assignees: [],
        archivedAt: null,
      };
      const findReminder = (
        tx as unknown as { clientReminder: { findFirst: ReturnType<typeof vi.fn> } }
      ).clientReminder.findFirst;
      findReminder.mockResolvedValue({ ...reminder, archivedAt: new Date() });
      if (phase === 'during-storage') findReminder.mockResolvedValueOnce(reminder);
      m.withTenantContext.mockImplementation(
        async (_ctx: unknown, fn: (value: unknown) => unknown) => fn(tx),
      );

      const res = await POST(makeRequest(reminderId));

      expect(res.status).toBe(phase === 'before-storage' ? 400 : 409);
      expect(m.createDocumentWithVersion).not.toHaveBeenCalled();
      expect(m.evidenceRecord).not.toHaveBeenCalled();
      expect(m.emitN8nEvent).not.toHaveBeenCalled();
      expect(storageJournal.objects).toHaveLength(phase === 'before-storage' ? 0 : 1);
      // Kein nachgelagertes Orphan-Journal mehr: die Vorab-Absicht bleibt offen
      // und traegt die gebundene Objektversion fuer den Cleanup-Worker.
      expect(storageJournal.events).not.toContain('compensate');
      expect(storageJournal.openIntents()).toHaveLength(phase === 'before-storage' ? 0 : 1);
      expect(
        (tx as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw,
      ).toHaveBeenCalledTimes(phase === 'before-storage' ? 1 : 2);
    },
  );

  it('uebernimmt Schutzstufe und Achtjahresfrist aus dem Kern-Typ im Classification-Backcompat-Pfad', async () => {
    const findBuiltin = vi.fn().mockResolvedValue({
      id: DOCUMENT_TYPE_ID,
      tier: 'GOBD',
      retentionYears: 8,
    });
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(commitTx({ documentType: { findFirst: findBuiltin } })),
    );
    m.createDocumentWithVersion.mockResolvedValue({
      document: { id: '33333333-3333-4333-8333-333333333333' },
    });
    m.evidenceRecord.mockResolvedValue(undefined);

    const res = await POST(makeClassificationRequest());

    expect(res.status).toBe(200);
    expect(findBuiltin).toHaveBeenCalledWith({
      where: {
        tenantId: SESSION.user.tenantId,
        classificationKey: 'GOBD_INVOICE',
        builtin: true,
        active: true,
      },
      select: { id: true, tier: true, retentionYears: true },
    });
    expect(m.classificationToTier).not.toHaveBeenCalled();
    expect(m.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'GOBD',
        classification: 'GOBD_INVOICE',
        retentionYears: 8,
      }),
    );
    expect(m.createDocumentWithVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        documentData: expect.objectContaining({
          classification: 'GOBD_INVOICE',
          documentTypeId: DOCUMENT_TYPE_ID,
        }),
      }),
    );
    expect(storageJournal.rows).toEqual([
      expect.objectContaining({ intent: true, resolution: 'REFERENCED', immutable: true }),
    ]);
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('P-13: speichert die Seitenzahl einer GwG-PDF beim Upload (vor dem Storage-Commit gezählt)', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    pdf.addPage();
    pdf.addPage();
    const pdfBytes = new Uint8Array(await pdf.save());
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(
        commitTx({
          documentType: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: DOCUMENT_TYPE_ID, tier: 'GWG', retentionYears: 5 }),
          },
        }),
      ),
    );
    m.createDocumentWithVersion.mockResolvedValue({
      document: { id: '33333333-3333-4333-8333-333333333333' },
    });
    m.evidenceRecord.mockResolvedValue(undefined);
    const fd = new FormData();
    fd.set('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'ausweis.pdf');
    fd.set('title', 'Ausweis');
    fd.set('classification', 'GWG_EVIDENCE');
    fd.set('mimeType', 'application/pdf');

    const res = await POST(
      new NextRequest('http://localhost:3000/api/staff/documents/commit', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
        body: fd,
      }),
    );

    expect(res.status).toBe(200);
    expect(m.createDocumentWithVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        documentData: expect.objectContaining({ classification: 'GWG_EVIDENCE' }),
        pdfPageCount: 3,
      }),
    );
  });

  it('P-13: zählt keine Seiten außerhalb von GwG-Belegen', async () => {
    m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
      fn(
        commitTx({
          documentType: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: DOCUMENT_TYPE_ID, tier: 'GOBD', retentionYears: 8 }),
          },
        }),
      ),
    );
    m.createDocumentWithVersion.mockResolvedValue({
      document: { id: '33333333-3333-4333-8333-333333333333' },
    });
    m.evidenceRecord.mockResolvedValue(undefined);

    expect((await POST(makeClassificationRequest())).status).toBe(200);
    expect(m.createDocumentWithVersion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pdfPageCount: null }),
    );
  });

  it('liefert 409, wenn eine Referenz nach Vorpruefung und Storage-Commit verschwindet', async () => {
    const preStorageTx = gobdTypeTx();
    const finalTx = commitTx({
      ...gobdTypeTx(),
      client: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn(preStorageTx),
      )
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(finalTx));

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'reference_changed',
      message: 'Referenz hat sich waehrend des Uploads geaendert.',
    });
    expect(m.prepare).toHaveBeenCalledTimes(1);
    expect(m.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 'GOBD',
        classification: 'GOBD_INVOICE',
        retentionYears: 8,
      }),
    );
    expect(m.createDocumentWithVersion).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
    expect(m.emitN8nEvent).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-1',
        source: 'staff.document.commit',
        storageKey: storageJournal.objects[0]!.key,
        storageVersionId: storageJournal.objects[0]!.versionId,
        immutable: true,
      }),
    ]);
  });

  it('liefert 409, wenn sich der Datei-Typ zwischen Vorpruefung und Commit aendert', async () => {
    const finalTx = commitTx({
      ...gobdTypeTx(),
      documentType: {
        findFirst: vi.fn().mockResolvedValue({
          id: DOCUMENT_TYPE_ID,
          tier: 'GOBD',
          classificationKey: 'GOBD_INVOICE',
          retentionYears: 10,
        }),
      },
    });
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn(gobdTypeTx()),
      )
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(finalTx));

    const res = await POST(makeRequest());

    expect(res.status).toBe(409);
    expect(m.createDocumentWithVersion).not.toHaveBeenCalled();
    expect(storageJournal.openIntents()).toHaveLength(1);
  });

  // K-06: Prozessabbruch (OOM, Deploy-Neustart) zwischen Object-Write und DB-Commit.
  it('hinterlaesst nach einem Abbruch zwischen PUT und DB-Commit eine aufloesbare Speicherabsicht', async () => {
    m.withTenantContext
      .mockImplementationOnce(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
        fn(gobdTypeTx()),
      )
      .mockImplementationOnce(() => processCrash());

    void POST(makeRequest());
    await waitForEvent('put:');

    const [intent] = storageJournal.openIntents();
    expect(storageJournal.events.indexOf('journal')).toBeLessThan(
      storageJournal.events.findIndex((event) => event.startsWith('put:')),
    );
    expect(intent).toMatchObject({
      tenantId: 'tenant-1',
      source: 'staff.document.commit',
      storageKey: storageJournal.objects[0]!.key,
      immutable: true,
      retentionUntil: storageJournal.objects[0]!.retainUntil,
    });
    expect(storageJournal.workerContract(intent!)).toEqual({
      selectable: true,
      tenantPrefix: true,
      objectVersions: 1,
      retentionGated: true,
    });
  });
});
