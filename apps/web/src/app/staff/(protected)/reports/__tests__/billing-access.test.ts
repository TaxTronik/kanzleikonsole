import { readFileSync } from 'node:fs';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadReports } from '../data';

const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

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

  it('gates every billing section with the admin/partner role result', () => {
    expect(pageSource).toContain('const canViewBilling = isStaffAdmin(session)');
    expect(pageSource).toContain('loadReports(tx, canViewBilling)');
    expect(pageSource.match(/\{billing && \(/g)).toHaveLength(3);
  });
});
