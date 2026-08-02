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
        findFirst: vi.fn().mockResolvedValue({ id: '3f2a1c88-5d4e-4b0a-9c11-7e6d5a4b3c2d' }),
      },
    }),
  );
});

describe('GET /api/staff/admin/backups/[id]/download', () => {
  it('liefert einen vollständigen DB-Dump niemals an eine Tenant-Session aus', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/staff/admin/backups/3f2a1c88-5d4e-4b0a-9c11-7e6d5a4b3c2d/download?source=s3',
    );

    const res = await GET(req, {
      params: Promise.resolve({ id: '3f2a1c88-5d4e-4b0a-9c11-7e6d5a4b3c2d' }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'backup_download_operator_only' });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'backup.download_denied',
        resourceId: '3f2a1c88-5d4e-4b0a-9c11-7e6d5a4b3c2d',
        after: {
          source: 's3',
          reason: 'operator_only_full_database_dump',
        },
      }),
    );
  });

  it('weist eine Nicht-UUID mit 404 ab, statt Prisma P2023 in einen 500 laufen zu lassen', async () => {
    const req = new NextRequest(
      'http://localhost:3000/api/staff/admin/backups/nicht-uuid/download?source=s3',
    );

    const res = await GET(req, { params: Promise.resolve({ id: 'nicht-uuid' }) });

    expect(res.status).toBe(404);
    // Die Abweisung erfolgt NACH dem Admin-Gate: ein Nicht-Admin bekommt
    // weiterhin 403, erfährt also nichts über die Existenz von IDs.
    expect(m.isStaffAdmin).toHaveBeenCalled();
  });
});
