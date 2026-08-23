import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    portalActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    checkPortalWriteLimit: vi.fn(),
    checkRateLimit: vi.fn(),
    assertPortalFeature: vi.fn(),
    commitDocumentFromBytes: vi.fn(),
    compensateStorageCommit: vi.fn(),
    deleteObject: vi.fn(),
    deleteObjectVersion: vi.fn(),
    evidenceRecord: vi.fn(),
    emitN8nEvent: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({
  commitDocumentFromBytes: h.commitDocumentFromBytes,
  deleteObject: h.deleteObject,
  deleteObjectVersion: h.deleteObjectVersion,
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: h.emitN8nEvent }));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit,
  checkPortalWriteLimit: h.checkPortalWriteLimit,
}));
vi.mock('@/server/settings/portal-features', () => ({
  assertPortalFeature: h.assertPortalFeature,
}));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: h.compensateStorageCommit,
}));
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'Fehler.',
  }),
}));
vi.mock('@/server/actions/portal-action', () => ({
  portalActionGuard: h.portalActionGuard,
  ActionError: h.ActionError,
}));

import {
  discardFormFileAction,
  saveSubmissionDraftAction,
  submitSubmissionAction,
  uploadFormFileAction,
} from '../actions';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';

function submission() {
  return {
    id: SUBMISSION_ID,
    tenantId: 'tenant-1',
    clientId: 'client-1',
    status: 'DRAFT',
    requestId: 'request-1',
    template: {
      fields: [{ key: 'name', label: 'Name', required: true, type: 'TEXT' }],
    },
  };
}

function fileSubmission(answers: Record<string, unknown> = {}) {
  return {
    ...submission(),
    answers,
    template: {
      fields: [
        {
          key: 'beleg',
          label: 'Beleg',
          required: false,
          type: 'FILE',
          minValue: null,
          maxValue: null,
          options: null,
        },
      ],
    },
  };
}

function mockTx(updateCount = 1) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'request-1' }]),
    formSubmission: {
      findUnique: vi.fn().mockResolvedValue(submission()),
      updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
    },
    request: {
      findMany: vi.fn().mockResolvedValue([{ id: 'request-1', status: 'OPEN' }]),
      findFirst: vi.fn().mockResolvedValue({ id: 'request-1', status: 'OPEN' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    document: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    storageOrphan: {
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  h.withTenantContext.mockImplementation(
    async (_ctx: unknown, run: (client: typeof tx) => unknown) => run(tx),
  );
  return tx;
}

describe('Formular-Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.portalActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      clientId: 'client-1',
      ctx: { tenantId: 'tenant-1', actorId: 'contact-1', actorType: 'CLIENT_CONTACT' },
    });
    h.checkPortalWriteLimit.mockResolvedValue({ ok: true });
    h.checkRateLimit.mockResolvedValue({ ok: true });
    h.assertPortalFeature.mockResolvedValue(undefined);
    h.commitDocumentFromBytes.mockResolvedValue({
      targetBucket: 'general',
      targetKey: 'tenant-1/form-upload.bin',
      storageVersionId: 'version-1',
      sha256: Buffer.alloc(32, 1),
      sizeBytes: 4n,
      immutable: false,
      retentionUntil: null,
      detectedMime: 'application/pdf',
    });
    h.compensateStorageCommit.mockResolvedValue('JOURNALED');
    h.deleteObject.mockResolvedValue(undefined);
    h.deleteObjectVersion.mockResolvedValue(undefined);
    h.evidenceRecord.mockResolvedValue(undefined);
    h.emitN8nEvent.mockResolvedValue(undefined);
  });

  it('speichert Drafts ausschließlich aus PENDING oder DRAFT', async () => {
    const tx = mockTx();

    const result = await saveSubmissionDraftAction({
      submissionId: SUBMISSION_ID,
      answers: { name: 'Mara' },
    });

    expect(result).toEqual({ ok: true });
    expect(tx.formSubmission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: SUBMISSION_ID,
          clientId: 'client-1',
          status: { in: ['PENDING', 'DRAFT'] },
        },
      }),
    );
  });

  it('emittiert bei verlorenem Submit-Claim weder Evidenz noch Event', async () => {
    mockTx(0);

    const result = await submitSubmissionAction({
      submissionId: SUBMISSION_ID,
      answers: { name: 'Mara' },
    });

    expect(result).toEqual({ ok: false, error: 'Formular wurde bereits übermittelt.' });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.emitN8nEvent).not.toHaveBeenCalled();
  });

  it('setzt die verknüpfte Anforderung in derselben Transaktion auf RESPONDED', async () => {
    const tx = mockTx();

    const result = await submitSubmissionAction({
      submissionId: SUBMISSION_ID,
      answers: { name: 'Mara' },
    });

    expect(result).toEqual({ ok: true });
    expect(tx.request.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['request-1'] },
        tenantId: 'tenant-1',
        clientId: 'client-1',
        status: { in: ['OPEN', 'IN_PROGRESS'] },
      },
      data: { status: 'RESPONDED' },
    });
    expect(h.evidenceRecord).toHaveBeenCalledTimes(2);
    expect(h.evidenceRecord).toHaveBeenNthCalledWith(
      1,
      tx,
      expect.objectContaining({
        action: 'request.responded',
        resourceId: 'request-1',
        after: expect.objectContaining({ status: 'RESPONDED', source: 'FORM_SUBMISSION' }),
      }),
    );
    expect(h.emitN8nEvent).toHaveBeenCalledWith(
      'request.responded',
      expect.objectContaining({ requestId: 'request-1', formSubmissionId: SUBMISSION_ID }),
      { tenantId: 'tenant-1' },
    );
  });

  it.each(['CLOSED', 'CANCELLED', 'RESPONDED'])(
    'sperrt Draft und Submit, sobald die verknüpfte Anforderung %s ist',
    async (status) => {
      const tx = mockTx();
      tx.request.findFirst.mockResolvedValue({ id: 'request-1', status });

      await expect(
        saveSubmissionDraftAction({ submissionId: SUBMISSION_ID, answers: { name: 'Mara' } }),
      ).resolves.toEqual({
        ok: false,
        error: 'Diese Anforderung ist abgeschlossen. Das Formular ist gesperrt.',
      });
      await expect(
        submitSubmissionAction({ submissionId: SUBMISSION_ID, answers: { name: 'Mara' } }),
      ).resolves.toEqual({
        ok: false,
        error: 'Diese Anforderung ist abgeschlossen. Das Formular ist gesperrt.',
      });
      expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
      expect(h.emitN8nEvent).not.toHaveBeenCalled();
    },
  );

  it('sperrt einen Legacy-Fallback mit gemischten offenen und geschlossenen Requests', async () => {
    const tx = mockTx();
    tx.formSubmission.findUnique.mockResolvedValue({ ...submission(), requestId: null });
    tx.request.findMany.mockResolvedValue([
      { id: 'request-1', status: 'OPEN' },
      { id: 'request-2', status: 'CLOSED' },
    ]);
    tx.request.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        id: where.id,
        status: where.id === 'request-1' ? 'OPEN' : 'CLOSED',
      }),
    );

    const result = await saveSubmissionDraftAction({
      submissionId: SUBMISSION_ID,
      answers: { name: 'Mara' },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Diese Anforderung ist abgeschlossen. Das Formular ist gesperrt.',
    });
    expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3); // Submission + beide Requests
  });

  it('validiert Feldtyp, Auswahl und Grenzen serverseitig vor dem Submit', async () => {
    const tx = mockTx();
    tx.formSubmission.findUnique.mockResolvedValue({
      ...submission(),
      template: {
        fields: [
          {
            key: 'email',
            label: 'E-Mail',
            required: true,
            type: 'EMAIL',
            minValue: null,
            maxValue: null,
            options: null,
          },
        ],
      },
    });

    const result = await submitSubmissionAction({
      submissionId: SUBMISSION_ID,
      answers: { email: 'keine-mail' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('gültige E-Mail-Adresse');
    expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
    expect(h.emitN8nEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['Draft', saveSubmissionDraftAction],
    ['Submit', submitSubmissionAction],
  ])(
    'lässt einen gebundenen Upload durch einen stale %s-Payload nicht verschwinden',
    async (_name, action) => {
      const tx = mockTx();
      tx.formSubmission.findUnique.mockResolvedValue(
        fileSubmission({
          beleg: {
            documentId: '22222222-2222-4222-8222-222222222222',
            fileName: 'beleg.pdf',
          },
        }),
      );
      tx.document.findMany.mockResolvedValue([
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'beleg.pdf',
          formFieldKey: 'beleg',
        },
      ]);

      const result = await action({ submissionId: SUBMISSION_ID, answers: {} });

      expect(result).toEqual({
        ok: false,
        error:
          'Formulardateien wurden zwischenzeitlich geändert. Bitte laden Sie das Formular neu.',
      });
      expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
      expect(h.emitN8nEvent).not.toHaveBeenCalled();
    },
  );

  it('akzeptiert bei FILE-Antworten keinen manipulierten Dateinamen', async () => {
    const tx = mockTx();
    tx.formSubmission.findUnique.mockResolvedValue(fileSubmission());
    tx.document.findMany.mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'kanonisch.pdf',
        formFieldKey: 'beleg',
      },
    ]);

    const result = await saveSubmissionDraftAction({
      submissionId: SUBMISSION_ID,
      answers: {
        beleg: {
          documentId: '22222222-2222-4222-8222-222222222222',
          fileName: 'irreführend.pdf',
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Formulardateien wurden zwischenzeitlich geändert');
    expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
  });

  it('lehnt Folgeupload im belegten FILE-Feld ab und journalisiert dessen Storage-Commit', async () => {
    const tx = mockTx();
    tx.formSubmission.findUnique.mockResolvedValue(fileSubmission());
    tx.document.findFirst.mockResolvedValue({ id: 'document-existing' });
    const documentCreate = vi.fn();
    Object.assign(tx.document, { create: documentCreate });

    const result = await uploadFormFileAction({
      submissionId: SUBMISSION_ID,
      fieldKey: 'beleg',
      fileName: 'zweiter-beleg.pdf',
      mimeType: 'application/pdf',
      base64: Buffer.from('test').toString('base64'),
    });

    expect(result).toEqual({
      ok: false,
      error:
        'Für dieses Feld wurde bereits eine Datei hochgeladen. Bitte entfernen Sie diese zuerst.',
    });
    expect(documentCreate).not.toHaveBeenCalled();
    expect(h.compensateStorageCommit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', source: 'portal.form.file' }),
    );
  });

  it('serialisiert parallele Uploads desselben Felds auf genau ein Dokument', async () => {
    const tx = mockTx();
    let currentAnswers: Record<string, unknown> = {};
    let liveDocument: { id: string; title: string } | null = null;
    tx.formSubmission.findUnique.mockImplementation(() =>
      Promise.resolve(fileSubmission(currentAnswers)),
    );
    tx.document.findFirst.mockImplementation(() => Promise.resolve(liveDocument));
    const documentCreate = vi.fn().mockImplementation(({ data }: { data: { title: string } }) => {
      liveDocument = { id: 'document-winner', title: data.title };
      return Promise.resolve(liveDocument);
    });
    Object.assign(tx.document, { create: documentCreate });
    Object.assign(tx, { documentVersion: { create: vi.fn().mockResolvedValue({}) } });
    tx.formSubmission.updateMany.mockImplementation(({ data }: { data: { answers?: unknown } }) => {
      if (data.answers && typeof data.answers === 'object') {
        currentAnswers = data.answers as Record<string, unknown>;
      }
      return Promise.resolve({ count: 1 });
    });

    // Modelliert den transaktionsgebundenen FOR-UPDATE-Lock der Submission:
    // Beide Storage-Commits dürfen parallel fertig werden, die beiden
    // abschließenden DB-Callbacks sehen den Feldzustand aber nacheinander.
    let transactionTail = Promise.resolve();
    h.withTenantContext.mockImplementation(
      (_ctx: unknown, run: (client: typeof tx) => Promise<unknown>) => {
        const ready = transactionTail;
        let release!: () => void;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        return ready.then(() => run(tx)).finally(release);
      },
    );

    const input = {
      submissionId: SUBMISSION_ID,
      fieldKey: 'beleg',
      fileName: 'beleg.pdf',
      mimeType: 'application/pdf',
      base64: Buffer.from('test').toString('base64'),
    };
    const results = await Promise.all([uploadFormFileAction(input), uploadFormFileAction(input)]);

    expect(results).toEqual(
      expect.arrayContaining([
        { ok: true, documentId: 'document-winner' },
        {
          ok: false,
          error:
            'Für dieses Feld wurde bereits eine Datei hochgeladen. Bitte entfernen Sie diese zuerst.',
        },
      ]),
    );
    expect(h.commitDocumentFromBytes).toHaveBeenCalledTimes(2);
    expect(documentCreate).toHaveBeenCalledTimes(1);
    expect(h.compensateStorageCommit).toHaveBeenCalledTimes(1);
    expect(currentAnswers).toEqual({
      beleg: { documentId: 'document-winner', fileName: 'beleg.pdf' },
    });
  });

  it('bindet einen Upload explizit an Submission und FILE-Feld und gibt ihn sofort frei', async () => {
    const tx = mockTx();
    tx.formSubmission.findUnique.mockResolvedValue({
      ...submission(),
      answers: {},
      template: {
        fields: [
          {
            key: 'beleg',
            label: 'Beleg',
            required: false,
            type: 'FILE',
            minValue: null,
            maxValue: null,
            options: null,
          },
        ],
      },
    });
    const documentCreate = vi.fn().mockResolvedValue({ id: 'document-1' });
    const versionCreate = vi.fn().mockResolvedValue({});
    Object.assign(tx.document, { create: documentCreate });
    Object.assign(tx, { documentVersion: { create: versionCreate } });

    const result = await uploadFormFileAction({
      submissionId: SUBMISSION_ID,
      fieldKey: 'beleg',
      fileName: 'beleg.pdf',
      mimeType: 'application/octet-stream',
      base64: Buffer.from('test').toString('base64'),
    });

    expect(result).toEqual({ ok: true, documentId: 'document-1' });
    expect(documentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        clientId: 'client-1',
        formSubmissionId: SUBMISSION_ID,
        formFieldKey: 'beleg',
        mimeType: 'application/pdf',
        sharedWithClientAt: expect.any(Date),
      }),
    });
    expect(tx.formSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        id: SUBMISSION_ID,
        clientId: 'client-1',
        status: { in: ['PENDING', 'DRAFT'] },
      },
      data: {
        status: 'DRAFT',
        answers: {
          beleg: { documentId: 'document-1', fileName: 'beleg.pdf' },
        },
      },
    });
  });

  it('löscht einen eigenen Formular-Upload vor Submit physisch und trennt den Draft', async () => {
    const tx = mockTx();
    tx.formSubmission.findUnique.mockResolvedValue({
      ...submission(),
      answers: {
        beleg: {
          documentId: '22222222-2222-4222-8222-222222222222',
          fileName: 'beleg.pdf',
        },
      },
      template: {
        fields: [
          {
            key: 'beleg',
            label: 'Beleg',
            required: false,
            type: 'FILE',
            minValue: null,
            maxValue: null,
            options: null,
          },
        ],
      },
    });
    const documentFindFirst = vi.fn().mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      title: 'beleg.pdf',
      versions: [
        {
          storageBucket: 'general',
          storageKey: 'tenant-1/form-upload.bin',
          storageVersionId: 'version-1',
          immutable: false,
          scanStatus: 'CLEAN',
          sha256: Buffer.alloc(32, 2),
          sizeBytes: 123n,
        },
      ],
    });
    const documentDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    Object.assign(tx.document, {
      findFirst: documentFindFirst,
      deleteMany: documentDeleteMany,
    });
    tx.$queryRaw.mockImplementation((query: TemplateStringsArray) =>
      Promise.resolve(
        query.join('?').includes('journal_open_form_upload_discard')
          ? [{ orphanId: 'orphan-1' }]
          : [{ id: 'request-1' }],
      ),
    );

    const result = await discardFormFileAction({
      submissionId: SUBMISSION_ID,
      fieldKey: 'beleg',
      documentId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result).toEqual({ ok: true });
    expect(h.deleteObjectVersion).toHaveBeenCalledWith(
      'general',
      'tenant-1/form-upload.bin',
      'version-1',
    );
    expect(tx.formSubmission.updateMany).toHaveBeenCalledWith({
      where: {
        id: SUBMISSION_ID,
        clientId: 'client-1',
        status: { in: ['PENDING', 'DRAFT'] },
      },
      data: { answers: { beleg: null } },
    });
    expect(documentDeleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: '22222222-2222-4222-8222-222222222222',
        formSubmissionId: SUBMISSION_ID,
        formFieldKey: 'beleg',
      }),
    });
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'form.submission.upload.discard' }),
    );
    const journalCall = tx.$queryRaw.mock.calls.find((call) =>
      (call[0] as TemplateStringsArray).join('?').includes('journal_open_form_upload_discard'),
    );
    expect(journalCall).toBeDefined();
    expect(journalCall?.slice(1)).toEqual([
      SUBMISSION_ID,
      'beleg',
      '22222222-2222-4222-8222-222222222222',
    ]);
    // Das Portal erhaelt bewusst kein UPDATE-Recht auf das SYSTEM-Journal.
    // Dessen Abschluss uebernimmt der idempotente Orphan-Cleanup-Worker.
    expect(tx.storageOrphan.updateMany).not.toHaveBeenCalled();
  });
});
