// P-22: Der Backup-Button reiht nur den Worker-Job ein; Doppelstarts verhindern
// Queue und Datenbank, nicht eine Modulvariable.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  isStaffAdmin: vi.fn(),
  withTenantContext: vi.fn(),
  record: vi.fn(),
  tenants: vi.fn(),
  latest: vi.fn(),
  rateLimit: vi.fn(),
  enqueue: vi.fn(),
  jobState: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({ env: { NEXTAUTH_URL: 'https://kanzlei.example.test' } }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({ isStaffAdmin: m.isStaffAdmin }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.record } }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: { tenant: { findMany: m.tenants } } }));
vi.mock('@/server/http/assert-same-origin', () => ({ assertSameOrigin: () => null }));
vi.mock('@/server/rate-limit', () => ({
  getClientIp: () => '203.0.113.7',
  checkStaffExportLimit: m.rateLimit,
}));
vi.mock('@/server/jobs/backup-run-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/jobs/backup-run-queue')>()),
  enqueueManualBackup: m.enqueue,
  getManualBackupJobState: m.jobState,
}));
// Der Request-Pfad darf den pg_dump-Runner nicht mehr laden.
vi.mock('@/server/backup/runner', () => {
  throw new Error('runner must not be imported by the route');
});

import { GET, POST } from '../route';
import type { NextRequest } from 'next/server';

function request(): NextRequest {
  return new Request('https://kanzlei.example.test/api/staff/admin/backups/run', {
    method: 'POST',
    headers: { 'user-agent': 'vitest' },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.staffAuth.mockResolvedValue({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } });
  m.isStaffAdmin.mockReturnValue(true);
  m.rateLimit.mockResolvedValue({ ok: true });
  m.tenants.mockResolvedValue([{ id: 'tenant-1' }]);
  m.latest.mockResolvedValue(null);
  m.jobState.mockResolvedValue(null);
  m.enqueue.mockResolvedValue(true);
  m.withTenantContext.mockImplementation(async (_ctx, fn) =>
    fn({ backupRecord: { findFirst: m.latest } }),
  );
});

describe('POST /api/staff/admin/backups/run', () => {
  it('protokolliert den Auslöser und reiht den Worker-Job ein (202)', async () => {
    const res = await POST(request());

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true, queued: true });
    expect(m.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'backup.trigger', after: { source: 'admin-browser' } }),
    );
    expect(m.enqueue).toHaveBeenCalledWith('tenant-1', 'staff-1');
    expect(m.record).toHaveBeenCalledBefore(m.enqueue);
  });

  it.each([
    ['ein manueller Lauf wartet', () => m.jobState.mockResolvedValue('waiting')],
    ['ein manueller Lauf läuft', () => m.jobState.mockResolvedValue('active')],
    [
      'ein Backup-Record läuft (auch der nächtliche Job)',
      () => m.latest.mockResolvedValue({ status: 'RUNNING', startedAt: new Date() }),
    ],
  ])('verweigert einen Doppelstart, wenn %s', async (_label, arrange) => {
    arrange();

    const res = await POST(request());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'backup_already_running' });
    expect(m.record).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('ignoriert einen verwaisten RUNNING-Record (älter als 6 h)', async () => {
    m.latest.mockResolvedValue({
      status: 'RUNNING',
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    expect((await POST(request())).status).toBe(202);
  });

  it('meldet einen parallel gewonnenen Queue-Eintrag als laufend', async () => {
    m.enqueue.mockResolvedValue(false);

    expect((await POST(request())).status).toBe(409);
  });

  it('startet in Multi-Tenant-Installationen kein Browser-Backup', async () => {
    m.tenants.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);

    const res = await POST(request());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'backup_scope_not_allowed' });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('verlangt Admin-Rechte', async () => {
    m.isStaffAdmin.mockReturnValue(false);

    expect((await POST(request())).status).toBe(403);
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe('GET /api/staff/admin/backups/run', () => {
  it('liefert Job-Zustand und letzten Backup-Record', async () => {
    m.jobState.mockResolvedValue('active');
    m.latest.mockResolvedValue({
      id: 'record-1',
      status: 'RUNNING',
      startedAt: new Date('2026-10-05T10:00:00Z'),
      finishedAt: null,
    });

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      job: 'active',
      latest: {
        id: 'record-1',
        status: 'RUNNING',
        startedAt: '2026-10-05T10:00:00.000Z',
        finishedAt: null,
      },
    });
  });
});
