import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  isStaffAdmin: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  checkDownloadLimit: vi.fn(),
}));

vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ isStaffAdmin: m.isStaffAdmin }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => '127.0.0.1',
  checkStaffBackupDownloadLimit: m.checkDownloadLimit,
}));

import { GET } from '../route';

const SESSION = {
  user: { tenantId: 'tenant-1', staffId: 'staff-1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.staffAuth.mockResolvedValue(SESSION);
  m.isStaffAdmin.mockReturnValue(true);
  m.checkDownloadLimit.mockResolvedValue({ ok: true });
  m.evidenceRecord.mockResolvedValue(undefined);
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      backupRecord: {
        findFirst: vi.fn().mockResolvedValue({ id: 'backup-1' }),
      },
    }),
  );
});

describe('GET /api/staff/admin/backups/[id]/download', () => {
  it('liefert einen vollständigen DB-Dump niemals an eine Tenant-Session aus', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/staff/admin/backups/backup-1/download?source=s3',
    );

    const res = await GET(req, { params: Promise.resolve({ id: 'backup-1' }) });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'backup_download_operator_only' });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'backup.download_denied',
        resourceId: 'backup-1',
        after: {
          source: 's3',
          reason: 'operator_only_full_database_dump',
        },
      }),
    );
  });
});
