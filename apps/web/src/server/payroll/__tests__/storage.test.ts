// Fachkatalog: PAYROLL-INTAKE-001, DOC-UPLOAD-JOURNAL-001
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  payrollTx: vi.fn(),
  recover: vi.fn(),
  commit: vi.fn(),
  getHash: vi.fn(),
  guestRead: vi.fn(),
  withCapability: vi.fn(),
}));
vi.mock('../service', () => ({ payrollTx: mocks.payrollTx }));
vi.mock('../capability', () => ({
  requireGuestHash: mocks.getHash,
  guestRead: mocks.guestRead,
  withPayrollCapability: mocks.withCapability,
}));
vi.mock('@taxtronik/storage', () => ({
  recoverPreparedBytesCommit: mocks.recover,
  commitPreparedBytes: mocks.commit,
  prepareBytesCommitWithTier: vi.fn(),
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  s3: { send: vi.fn() },
}));
import { persistPayrollFile, PayrollUploadError } from '../storage';

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  intakeId: '33333333-3333-4333-8333-333333333333',
  audience: 'STAFF',
  revision: 3,
  filename: 'test.pdf',
  mimeType: 'application/pdf',
  status: 'PENDING',
  storageBucket: 'private',
  storageKey: 'fixed-key',
  storageVersionId: null,
  sha256: 'ab'.repeat(32),
  sizeBytes: 12n,
};
const item = {
  id: row.intakeId,
  revision: 3,
  status: 'DRAFT',
  revokedAt: null as Date | null,
  expiresAt: new Date('2099-01-01'),
  employerConfirmedAt: null as Date | null,
};
const tx = { payrollAttachment: { findFirst: vi.fn(), updateMany: vi.fn() } };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(item, { revision: 3, status: 'DRAFT', revokedAt: null, employerConfirmedAt: null });
  tx.payrollAttachment.findFirst.mockResolvedValue(row);
  tx.payrollAttachment.updateMany.mockResolvedValue({ count: 1 });
  mocks.payrollTx.mockImplementation(async (_surface, _id, fn) => fn(tx, item));
  mocks.recover.mockResolvedValue({ storageVersionId: 'verified-version' });
});
const run = (extra: Record<string, unknown> = {}) =>
  persistPayrollFile({
    surface: 'staff',
    intakeId: row.intakeId,
    filename: 'test.pdf',
    bytes: async () => Buffer.from('same file'),
    resumeId: row.id,
    ...extra,
  });

describe('PAYROLL-INTAKE-001 storage finalization races', () => {
  it('recovers the exact journal version without repeating PUT and requires a successful CAS', async () => {
    const result = await run();
    expect(result.storageVersionId).toBe('verified-version');
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(tx.payrollAttachment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: row.id,
          intakeId: row.intakeId,
          revision: 3,
          status: 'PENDING',
        }),
      }),
    );
  });
  it.each(['revoked', 'submitted', 'expired', 'employer-confirmed'])(
    'rejects a %s source after S3 recovery without finalizing its journal',
    async (reason) => {
      mocks.recover.mockImplementation(async () => {
        if (reason === 'revoked') item.revokedAt = new Date();
        if (reason === 'submitted') item.status = 'SUBMITTED';
        if (reason === 'expired') item.expiresAt = new Date('2000-01-01');
        if (reason === 'employer-confirmed') item.employerConfirmedAt = new Date();
        return { storageVersionId: 'stored' };
      });
      await expect(
        run(reason === 'employer-confirmed' ? { surface: 'portal' } : {}),
      ).rejects.toBeInstanceOf(PayrollUploadError);
      expect(tx.payrollAttachment.updateMany).not.toHaveBeenCalled();
      item.expiresAt = new Date('2099-01-01');
    },
  );
  it('permits source recovery across another draft save, binding it only at later submission', async () => {
    mocks.recover.mockImplementation(async () => {
      item.revision = 4;
      return { storageVersionId: 'stored' };
    });
    await expect(run()).resolves.toMatchObject({ status: 'COMPLETE' });
  });
  it('rejects a changed reviewed revision for an artifact after S3 recovery', async () => {
    item.status = 'REVIEWED';
    mocks.recover.mockImplementation(async () => {
      item.revision = 4;
      return { storageVersionId: 'stored' };
    });
    await expect(run({ artifact: true, expectedRevision: 3 })).rejects.toBeInstanceOf(
      PayrollUploadError,
    );
    expect(tx.payrollAttachment.updateMany).not.toHaveBeenCalled();
  });
  it('does not report completion when the database CAS lost', async () => {
    tx.payrollAttachment.updateMany.mockResolvedValue({ count: 0 });
    await expect(run()).rejects.toBeInstanceOf(PayrollUploadError);
  });
});
