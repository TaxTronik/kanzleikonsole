import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffAuth: vi.fn(),
  requireClientAccess: vi.fn(),
  readModules: vi.fn(),
  findMany: vi.fn(),
  withTenant: vi.fn(),
  admin: false,
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: m.staffAuth }));
vi.mock('@/server/auth/rbac', () => ({
  requireClientAccess: m.requireClientAccess,
  ForbiddenError: class extends Error {},
  UnauthorizedError: class extends Error {},
  isStaffAdmin: () => m.admin,
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenant }));
vi.mock('@/server/settings/modules', () => ({ readModules: m.readModules }));
import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  m.admin = false;
  m.staffAuth.mockResolvedValue({ user: { tenantId: 'tenant-a', staffId: 'staff-a' } });
  m.readModules.mockResolvedValue({ reminders: true });
  m.requireClientAccess.mockResolvedValue(undefined);
  m.withTenant.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      clientReminder: { findMany: m.findMany },
      staffUser: { findMany: async () => [{ id: 'staff-a', fullName: 'Anna' }] },
    }),
  );
});

describe('REMINDER-TICKET-001 – Mandantenblock aktualisieren', () => {
  it('filtert das Archiv vor dem Limit und transportiert Nummer und Archivberechtigung', async () => {
    const row = {
      id: 'ticket-a',
      ticketNumber: 123,
      archivedAt: null,
      dueDate: new Date('2026-09-07'),
      subject: 'Test',
      notes: null,
      priority: 'NORMAL',
      doneAt: new Date('2026-09-07'),
      doneByStaff: 'staff-a',
      createdByStaff: 'staff-a',
      assignees: [{ staffId: 'staff-a' }],
      riskMarkings: [],
    };
    m.findMany.mockResolvedValue([
      row,
      { ...row, id: 'ticket-b', ticketNumber: 124, doneByStaff: null },
    ]);
    const response = await GET(
      new Request('https://fixture.test/api/staff/clients/client-a/reminders'),
      { params: Promise.resolve({ id: 'client-a' }) },
    );
    expect(response.status).toBe(200);
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'client-a', archivedAt: null },
        orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueDate: 'asc' }],
        take: 50,
      }),
    );
    expect((await response.json()).items).toEqual([
      expect.objectContaining({ ticketNumber: 123, archivedAt: null, canArchive: true }),
      expect.objectContaining({ ticketNumber: 124, canArchive: false }),
    ]);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('liefert bei abgeschaltetem Modul keine Ticketdaten', async () => {
    m.readModules.mockResolvedValue({ reminders: false });
    const response = await GET(new Request('https://fixture.test'), {
      params: Promise.resolve({ id: 'client-a' }),
    });
    expect(response.status).toBe(404);
    expect(m.findMany).not.toHaveBeenCalled();
  });
});
