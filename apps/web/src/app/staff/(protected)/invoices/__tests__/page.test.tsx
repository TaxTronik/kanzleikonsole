import type { InvoiceStatus } from '@prisma/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  requireStaffPage: vi.fn(),
  withTenantContext: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}));

vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: fixture.requireStaffPage }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: fixture.withTenantContext }));
vi.mock('@/server/auth/rbac', () => ({
  inaccessibleClientIdsFor: vi.fn(async () => []),
  hasStaffPermission: vi.fn(() => false),
}));

import InvoicesPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fixture.requireStaffPage.mockResolvedValue({
    user: { tenantId: 'tenant-test', staffId: 'staff-test' },
  });
  fixture.withTenantContext.mockImplementation(async (_ctx, run) =>
    run({ invoice: { findMany: fixture.findMany, count: fixture.count } }),
  );
  fixture.count.mockResolvedValue(1);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function renderInvoice(dueDay: string, status: InvoiceStatus = 'SENT') {
  fixture.findMany.mockResolvedValue([
    {
      id: 'invoice-test',
      number: '2026-0001',
      client: { id: 'client-test', name: 'Testmandant' },
      issueDate: new Date('2026-01-01T00:00:00.000Z'),
      // Prisma @db.Date liefert den Kalendertag als UTC-Mitternacht.
      dueDate: new Date(`${dueDay}T00:00:00.000Z`),
      totalAmount: '119.00',
      status,
    },
  ]);
  const html = renderToStaticMarkup(await InvoicesPage({ searchParams: Promise.resolve({}) }));
  return html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)![1]!;
}

describe('Rechnungsanzeige — INV-DUE-OVERDUE-001', () => {
  it.each([
    ['am Fälligkeitstag mittags', '2026-09-14', '2026-09-14T12:00:00.000Z', false],
    ['am Fälligkeitstag bis 23:59:59,999 CEST', '2026-09-14', '2026-09-14T21:59:59.999Z', false],
    ['ab 00:00 CEST des Folgetags', '2026-09-14', '2026-09-14T22:00:00.000Z', true],
    ['am Fälligkeitstag bis 23:59:59,999 CET', '2026-01-15', '2026-01-15T22:59:59.999Z', false],
    ['ab 00:00 CET des Folgetags', '2026-01-15', '2026-01-15T23:00:00.000Z', true],
    ['am letzten Moment des 23-Stunden-Tags', '2026-03-29', '2026-03-29T21:59:59.999Z', false],
    ['nach dem 23-Stunden-Tag', '2026-03-29', '2026-03-29T22:00:00.000Z', true],
    ['am letzten Moment des 25-Stunden-Tags', '2026-10-25', '2026-10-25T22:59:59.999Z', false],
    ['nach dem 25-Stunden-Tag', '2026-10-25', '2026-10-25T23:00:00.000Z', true],
    ['vor dem Fälligkeitstag', '2026-09-15', '2026-09-14T12:00:00.000Z', false],
  ])('zeigt SENT %s korrekt an', async (_label, dueDay, instant, overdue) => {
    vi.setSystemTime(new Date(instant));
    const row = await renderInvoice(dueDay);
    if (overdue) {
      expect(row).toContain('<span class="badge-red">Überfällig</span>');
      expect(row).toContain('class="px-6 py-4 text-red-700"');
    } else {
      expect(row).toContain('<span class="badge-yellow">Versendet</span>');
      expect(row).not.toContain('Überfällig');
      expect(row).not.toContain('text-red-700');
    }
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])(
    'verwendet auch bei Serverzeitzone %s die Berliner Tagesgrenze',
    async (timeZone) => {
      vi.stubEnv('TZ', timeZone);
      vi.setSystemTime(new Date('2026-09-14T21:59:59.999Z'));
      expect(await renderInvoice('2026-09-14')).not.toContain('Überfällig');
      vi.setSystemTime(new Date('2026-09-14T22:00:00.000Z'));
      expect(await renderInvoice('2026-09-14')).toContain('Überfällig');
    },
  );

  it.each([
    ['DRAFT', 'badge-gray', 'Entwurf'],
    ['PAID', 'badge-green', 'Bezahlt'],
    ['CANCELLED', 'badge-gray', 'Storniert'],
    ['OVERDUE', 'badge-red', 'Überfällig'],
  ] as const)('behält den gespeicherten Status %s bei', async (status, badge, label) => {
    vi.setSystemTime(new Date('2026-09-14T12:00:00.000Z'));
    const row = await renderInvoice('2026-09-01', status);
    expect(row).toContain(`<span class="${badge}">${label}</span>`);
  });
});
