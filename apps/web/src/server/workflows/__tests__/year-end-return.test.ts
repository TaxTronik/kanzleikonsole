// Fachkatalog: YEAR-END-CAMPAIGN-001, REQ-LIFECYCLE-001.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import type { StaffCtx } from '@/server/actions/staff-action';
const mocks = vi.hoisted(() => ({ access: vi.fn(), evidence: vi.fn() }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: mocks.access }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidence } }));
import { returnCampaignSubmissionTx } from '../year-end-return';
const at = new Date('2026-08-01T12:00:00Z');
const entry = {
  id: 'entry',
  tenantId: 'tenant',
  clientId: 'client',
  submissionId: 'sub',
  requestId: 'request',
  campaignId: 'campaign',
};
const sub = {
  id: 'sub',
  clientId: 'client',
  requestId: 'request',
  status: 'SUBMITTED',
  submittedAt: at,
  updatedAt: at,
  submittedByContact: 'contact',
  schemaSnapshot: { version: 1, name: 'Frozen', description: null, introMd: null, fields: [] },
  answers: {},
};
const request = { id: 'request', clientId: 'client', formSubmissionId: 'sub', status: 'RESPONDED' };
const tx = {
  $queryRaw: vi.fn(),
  yearEndCampaignEntry: { findUnique: vi.fn() },
  formSubmission: { findUnique: vi.fn(), updateMany: vi.fn() },
  formSubmissionRevision: { findFirst: vi.fn(), create: vi.fn() },
  request: { findUnique: vi.fn(), update: vi.fn() },
  requestResponse: { create: vi.fn() },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue(undefined);
  tx.yearEndCampaignEntry.findUnique.mockResolvedValue(entry);
  tx.formSubmission.findUnique.mockResolvedValue(sub);
  tx.formSubmission.updateMany.mockResolvedValue({ count: 1 });
  tx.request.findUnique.mockResolvedValue(request);
  tx.formSubmissionRevision.findFirst.mockResolvedValue(null);
});
const run = () =>
  returnCampaignSubmissionTx(
    tx as unknown as TxClient,
    { tenantId: 'tenant', staffId: 'staff', session: {} } as StaffCtx,
    { entryId: 'entry', note: 'Bitte den Inventurbestand ergänzen.', updatedAt: at },
  );
describe('YEAR-END-CAMPAIGN-001 explicit request for corrections', () => {
  it('opens the same frozen form and publishes a separate client-visible question, preserving answers and first submission evidence', async () => {
    await run();
    expect(tx.formSubmissionRevision.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant',
        submissionId: 'sub',
        sequence: 1,
        schemaSnapshot: sub.schemaSnapshot,
        answers: {},
        submittedAt: at,
        submittedByContact: 'contact',
        capturedByStaff: 'staff',
        files: { create: [] },
      },
    });
    expect(tx.formSubmissionRevision.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.formSubmission.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.formSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub', status: 'SUBMITTED', updatedAt: at },
      data: { status: 'DRAFT', reviewedAt: null, reviewedByStaff: null },
    });
    expect(tx.request.update).toHaveBeenCalledWith({
      where: { id: 'request' },
      data: { status: 'IN_PROGRESS', closedAt: null, closedByStaff: null },
    });
    expect(tx.requestResponse.create).toHaveBeenCalledWith({
      data: {
        requestId: 'request',
        authorType: 'STAFF',
        authorId: 'staff',
        message: 'Jahreswechsel-Rückfrage:\nBitte den Inventurbestand ergänzen.',
      },
    });
    expect(mocks.evidence).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'request.reopen' }),
    );
  });
  it('rejects missing client authorization before reopening any record', async () => {
    mocks.access.mockRejectedValue(new Error('denied'));
    await expect(run()).rejects.toThrow('denied');
    expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
  });
  it('rejects stale views, never-submitted drafts and cancelled requests', async () => {
    tx.formSubmission.findUnique.mockResolvedValue({
      ...sub,
      updatedAt: new Date(at.getTime() + 1),
    });
    await expect(run()).rejects.toThrow('zwischenzeitlich');
    tx.formSubmission.findUnique.mockResolvedValue({ ...sub, status: 'DRAFT', submittedAt: null });
    await expect(run()).rejects.toThrow('eingereichten');
    tx.formSubmission.findUnique.mockResolvedValue(sub);
    tx.request.findUnique.mockResolvedValue({ ...request, status: 'CANCELLED' });
    await expect(run()).rejects.toThrow('eingereichten');
    expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
  });
  it('does not publish a question when the form compare-and-swap lost', async () => {
    tx.formSubmission.updateMany.mockResolvedValue({ count: 0 });
    await expect(run()).rejects.toThrow('zwischenzeitlich');
    expect(tx.requestResponse.create).not.toHaveBeenCalled();
  });
  it('FORM-SCHEMA-SNAPSHOT-001 blocks legacy returns instead of inventing a former schema', async () => {
    tx.formSubmission.findUnique.mockResolvedValue({ ...sub, schemaSnapshot: null });
    await expect(run()).rejects.toThrow('Eingefrorener Fragenstand fehlt');
    expect(tx.formSubmissionRevision.create).not.toHaveBeenCalled();
    expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
  });
  it('does not reopen anything if preserving the original submission fails', async () => {
    tx.formSubmissionRevision.create.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await expect(run()).rejects.toThrow('snapshot unavailable');
    expect(tx.formSubmission.updateMany).not.toHaveBeenCalled();
    expect(tx.request.update).not.toHaveBeenCalled();
  });
});
