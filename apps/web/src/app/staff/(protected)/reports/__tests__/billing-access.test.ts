// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';

const h = vi.hoisted(() => ({ admin: false, tx: null as unknown }));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', staffId: 'staff-1', roles: ['EMPLOYEE'] },
  })),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@/server/auth/rbac', () => ({ isStaffAdmin: () => h.admin }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(h.tx)),
}));

import { loadReports } from '../data';
import ReportsPage from '../page';

const tx = {
  request: {
    groupBy: vi.fn(),
    count: vi.fn(),
  },
  timeEntry: {
    aggregate: vi.fn(),
  },
  invoice: {
    groupBy: vi.fn(),
    aggregate: vi.fn(),
  },
  $queryRaw: vi.fn(),
} as unknown as Prisma.TransactionClient;

describe('reports billing access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tx.request.groupBy).mockResolvedValue([]);
    vi.mocked(tx.request.count).mockResolvedValue(0);
    vi.mocked(tx.timeEntry.aggregate).mockResolvedValue({ _count: { _all: 0 } } as never);
    vi.mocked(tx.invoice.groupBy).mockResolvedValue([]);
    vi.mocked(tx.invoice.aggregate).mockResolvedValue({
      _sum: { totalAmount: null, netAmount: null },
      _count: { _all: 0 },
    } as never);
    vi.mocked(tx.$queryRaw).mockResolvedValue([]);
  });

  it('does not query or return invoice data for employees', async () => {
    const reports = await loadReports(tx, false);

    expect(reports.billing).toBeNull();
    expect(tx.invoice.groupBy).not.toHaveBeenCalled();
    expect(tx.invoice.aggregate).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('loads billing reports for admins and partners', async () => {
    const reports = await loadReports(tx, true);

    expect(reports.billing).not.toBeNull();
    expect(tx.invoice.groupBy).toHaveBeenCalledOnce();
    expect(tx.invoice.aggregate).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
  });

  // Seite als Render-Test (B-08, Welle 15) statt Quelltextprüfung.
  it.each([
    [false, 'Kanzlei-KPIs aus Anforderungen und Zeiterfassung.'],
    [true, 'Kanzlei-KPIs aus Anforderungen, Zeiterfassung und Rechnungswesen.'],
  ])(
    'blendet alle Abrechnungsbereiche nach der Admin/Partner-Rolle ein (Admin: %s)',
    async (admin, intro) => {
      h.admin = admin;
      h.tx = tx;
      await renderServer(ReportsPage());
      expect(screen.getByText(intro)).toBeTruthy();
      const billingSections = [
        screen.queryByText('Umsatz lfd. Jahr (netto)'),
        screen.queryByRole('heading', { name: 'Top-Mandanten — Umsatz im lfd. Jahr' }),
        screen.queryByRole('heading', { name: 'Rechnungen — Status' }),
      ];
      expect(billingSections.map(Boolean)).toEqual([admin, admin, admin]);
      expect(vi.mocked(tx.invoice.groupBy).mock.calls.length > 0).toBe(admin);
    },
  );
});
