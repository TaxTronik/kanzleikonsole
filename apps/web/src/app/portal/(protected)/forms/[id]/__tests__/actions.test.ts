import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  class ActionError extends Error {}
  return {
    ActionError,
    portalActionGuard: vi.fn(),
    withTenantContext: vi.fn(),
    checkPortalWriteLimit: vi.fn(),
    evidenceRecord: vi.fn(),
    emitN8nEvent: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/storage', () => ({ commitDocumentFromBytes: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: (value: unknown) => value }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: h.emitN8nEvent }));
vi.mock('@/server/rate-limit', () => ({
  checkRateLimit: vi.fn(),
  checkPortalWriteLimit: h.checkPortalWriteLimit,
}));
vi.mock('@/server/settings/portal-features', () => ({ assertPortalFeature: vi.fn() }));
vi.mock('@/server/documents/storage-compensation', () => ({
  compensateStorageCommit: vi.fn(),
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

import { saveSubmissionDraftAction, submitSubmissionAction } from '../actions';

const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';

function submission() {
  return {
    id: SUBMISSION_ID,
    clientId: 'client-1',
    status: 'DRAFT',
    requestId: 'request-1',
    template: {
      fields: [{ key: 'name', label: 'Name', required: true, type: 'TEXT' }],
    },
  };
}

function mockTx(updateCount = 1) {
  const tx = {
    formSubmission: {
      findUnique: vi.fn().mockResolvedValue(submission()),
      updateMany: vi.fn().mockResolvedValue({ count: updateCount }),
    },
    request: {
      findFirst: vi.fn().mockResolvedValue({ id: 'request-1', status: 'OPEN' }),
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
        id: 'request-1',
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

  it('schreibt bei bereits fachlich beantworteter Anforderung keine zweite Request-Evidenz', async () => {
    const tx = mockTx();
    tx.request.findFirst.mockResolvedValue({ id: 'request-1', status: 'RESPONDED' });
    tx.request.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      submitSubmissionAction({ submissionId: SUBMISSION_ID, answers: { name: 'Mara' } }),
    ).resolves.toEqual({ ok: true });

    expect(h.evidenceRecord).toHaveBeenCalledOnce();
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'form.submission.submit' }),
    );
  });
});
