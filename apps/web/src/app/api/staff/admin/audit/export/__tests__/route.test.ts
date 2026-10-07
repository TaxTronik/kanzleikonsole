import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), findMany: vi.fn(), record: vi.fn() }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.auth }));
vi.mock('@/server/auth/rbac', () => ({
  isStaffAdmin: (session: { user: { roles: string[] } }) =>
    session.user.roles.some((role) => ['ADMIN', 'PARTNER'].includes(role)),
}));
vi.mock('@/server/rate-limit', () => ({
  checkStaffExportLimit: async () => ({ ok: true }),
  getClientIp: () => null,
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ auditLog: { findMany: mocks.findMany } }),
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.record } }));
import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({
    user: { tenantId: 'tenant', staffId: 'staff', roles: ['ADMIN'] },
  });
  mocks.findMany.mockResolvedValue([]);
});

describe('AUDIT-HASH-CHAIN-001 / ACCESS-STAFF-PERMISSION-001: audit export selection', () => {
  it('does not grant audit access through professional qualification', async () => {
    mocks.auth.mockResolvedValueOnce({ user: { roles: ['EMPLOYEE'], isProfessional: true } });
    expect(
      (await GET(new NextRequest('http://localhost/api/staff/admin/audit/export'))).status,
    ).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it('uses category, order and Berlin day bounds while ignoring page cursors', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/staff/admin/audit/export?category=gwg&sort=oldest&from=2026-03-29&to=2026-03-29&cursor=100',
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            action: {
              in: expect.arrayContaining(['gwg.check.verify', 'client.update.gwg_relevant']),
            },
          },
        ],
        occurredAt: { gte: new Date('2026-03-28T23:00:00Z'), lt: new Date('2026-03-29T22:00:00Z') },
      },
      orderBy: { id: 'asc' },
      take: 10001,
    });
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: {
          rows: 0,
          truncated: false,
          filters: { category: 'gwg', sort: 'oldest', from: '2026-03-29', to: '2026-03-29' },
        },
      }),
    );
  });
  it('P-12: weist Anzahl und alle Dokument-IDs eines Sammel-Downloads in „Details“ aus', async () => {
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const row = (id: bigint, action: string, resourceId: string | null, after: unknown) => ({
      id,
      occurredAt: new Date('2026-10-04T10:00:00Z'),
      actorType: 'STAFF',
      actorId: 'staff',
      action,
      resourceType: 'document',
      resourceId,
      after,
      ip: null,
      thisHash: Buffer.alloc(32, 1),
      prevHash: Buffer.alloc(32, 2),
    });
    mocks.findMany.mockResolvedValue([
      row(2n, 'document.download.bulk', null, {
        documentCount: 2,
        documentIds: [first, second],
        folderIds: [],
      }),
      row(1n, 'document.download', first, null),
    ]);

    const response = await GET(new NextRequest('http://localhost/api/staff/admin/audit/export'));

    const [header, bulk, single] = (await response.text()).replace(/^\uFEFF/, '').split('\r\n');
    // Neue Spalte hinten; bestehende Spalten behalten ihre Position.
    expect(header!.split(';')).toEqual([
      'ID',
      'Zeitpunkt',
      'Akteur-Typ',
      'Akteur-ID',
      'Action',
      'Bereich',
      'Ressource',
      'Ressourcen-ID',
      'IP',
      'Hash',
      'Vorgänger-Hash',
      'Details',
    ]);
    expect(bulk!.split(';').at(-1)).toBe(`2 Dokumente: ${first} ${second}`);
    expect(single!.split(';').at(-1)).toBe('');
    expect(single!.split(';')[7]).toBe(first);
  });
  // Fachkatalog: DOC-VERSION-IMMUTABILITY-001 — Produktentscheidung A10 (2026-10-07):
  // Der DATEV-Belegexport weist seine Dokument-IDs wie der Sammel-Download aus.
  it('A10: weist Anzahl und Dokument-IDs eines DATEV-Belegexports in „Details“ aus', async () => {
    const client = '00000000-0000-4000-8000-0000000000c1';
    const first = '00000000-0000-4000-8000-000000000001';
    const second = '00000000-0000-4000-8000-000000000002';
    const row = (id: bigint, after: unknown) => ({
      id,
      occurredAt: new Date('2026-10-07T10:00:00Z'),
      actorType: 'STAFF',
      actorId: 'staff',
      action: 'client.belege.export',
      resourceType: 'client',
      resourceId: client,
      after,
      ip: null,
      thisHash: Buffer.alloc(32, 1),
      prevHash: Buffer.alloc(32, 2),
    });
    mocks.findMany.mockResolvedValue([
      row(2n, { documents: 2, documentIds: [first, second], from: null, to: null }),
      // Älterer Export vor A10: nur die Anzahl, keine erfundene ID-Liste.
      row(1n, { documents: 3, from: '2026-01-01', to: null }),
    ]);

    const response = await GET(new NextRequest('http://localhost/api/staff/admin/audit/export'));

    const [, current, legacy] = (await response.text()).replace(/^\uFEFF/, '').split('\r\n');
    expect(current!.split(';').at(-1)).toBe(`2 Dokumente: ${first} ${second}`);
    expect(current!.split(';')[7]).toBe(client);
    expect(legacy!.split(';').at(-1)).toBe('3 Dokumente (ohne ID-Liste)');
  });
  it('rejects invalid filters without reading or exporting the full log', async () => {
    expect(
      (await GET(new NextRequest('http://localhost/api/staff/admin/audit/export?category=invalid')))
        .status,
    ).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
