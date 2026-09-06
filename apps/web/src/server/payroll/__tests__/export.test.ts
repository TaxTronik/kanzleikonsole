// Fachkatalog: PAYROLL-INTAKE-001, DOC-UPLOAD-JOURNAL-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ payrollTx: vi.fn(), persist: vi.fn() }));
vi.mock('../service', () => ({ payrollTx: mocks.payrollTx }));
vi.mock('../storage', () => ({ persistPayrollFile: mocks.persist, payrollFileBytes: vi.fn() }));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: vi.fn().mockResolvedValue({ ok: true }),
}));
import { createPayrollExport } from '../export';
const id = '33333333-3333-4333-8333-333333333333',
  attachmentId = '44444444-4444-4444-8444-444444444444';
const item = {
  id,
  employeeLabel: 'Test',
  revision: 3,
  status: 'REVIEWED',
  revokedAt: null as Date | null,
  employerConfirmedAt: new Date(),
  employeeSubmittedAt: new Date(),
};
const tx = {
  payrollRevision: { findUnique: vi.fn() },
  payrollAttachment: { findMany: vi.fn() },
  payrollExport: { create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
};
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(item, { revision: 3, status: 'REVIEWED', revokedAt: null });
  tx.payrollRevision.findUnique.mockResolvedValue({
    snapshot: { attachments: [] },
    createdAt: new Date(),
  });
  tx.payrollAttachment.findMany.mockResolvedValue([]);
  tx.payrollExport.create.mockResolvedValue({ id: 'export', status: 'PENDING' });
  tx.payrollExport.updateMany.mockResolvedValue({ count: 1 });
  mocks.payrollTx.mockImplementation(async (_s, _id, fn) =>
    fn(tx, { ...item }, { ctx: { actorId: 'staff' }, tenantId: 'tenant' }),
  );
  mocks.persist.mockImplementation(async (options) => {
    await options.onJournal({ id: attachmentId });
    return { id: attachmentId };
  });
});
const run = () => {
  const data = new FormData();
  data.set('id', id);
  data.set('kind', 'PDF');
  return createPayrollExport(data);
};
describe('PAYROLL-INTAKE-001 reviewed export finalization', () => {
  it('binds generation and final CAS to the exact reviewed revision and artifact', async () => {
    await expect(run()).resolves.toContain(attachmentId);
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ artifact: true, expectedRevision: 3 }),
    );
    expect(tx.payrollExport.updateMany).toHaveBeenCalledWith({
      where: { id: 'export', intakeId: id, revision: 3, status: 'PENDING', attachmentId },
      data: { status: 'COMPLETE' },
    });
  });
  it.each(['revoked', 'returned', 'revision'])(
    'does not complete after concurrent %s change',
    async (reason) => {
      mocks.persist.mockImplementation(async (options) => {
        await options.onJournal({ id: attachmentId });
        if (reason === 'revoked') item.revokedAt = new Date();
        if (reason === 'returned') item.status = 'RETURNED';
        if (reason === 'revision') item.revision++;
        return { id: attachmentId };
      });
      await expect(run()).rejects.toThrow('Prüfstand');
      expect(tx.payrollExport.updateMany).not.toHaveBeenCalled();
    },
  );
  it('rejects a lost completion CAS', async () => {
    tx.payrollExport.updateMany.mockResolvedValue({ count: 0 });
    await expect(run()).rejects.toThrow('zwischenzeitlich');
  });
});
