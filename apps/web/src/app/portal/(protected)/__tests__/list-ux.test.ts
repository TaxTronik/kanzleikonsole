// @vitest-environment jsdom
// Fachkatalog: ACCESS-SEARCH-SCOPE-001, REQ-LIFECYCLE-001,
// DOC-PORTAL-SHARING-001, INV-PORTAL-SHARING-001
// Portal-Listen als Render-Tests gegen eine nachgebildete Tenant-Tx (B-08,
// Welle 15) statt Quelltextprüfung: serverseitige 25er-URL-Pagination, Suche
// als GET-Formular, mobile Karten und die Abfragen mit den vollständigen
// Portalregeln (Freigabe, Löschung, Sichtbarkeit, persönliche Anforderungen).
import { screen } from '@testing-library/react';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderServer } from '@/__tests__/render-helpers';
import { PORTAL_LIST_PAGE_SIZE } from '@/server/portal/list-query';
import { portalInvoiceVisibilityWhere } from '@/server/invoicing/portal-visibility';

const CLIENT = '44444444-4444-4444-8444-444444444444';

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  request: { findMany: vi.fn() },
  document: { count: vi.fn(), findMany: vi.fn() },
  invoice: { count: vi.fn(), findMany: vi.fn() },
}));

vi.mock('@/server/auth/portal', () => ({
  portalAuth: vi.fn(async () => ({
    user: { tenantId: 'tenant-1', contactId: 'contact-1', clientId: CLIENT },
  })),
}));
vi.mock('@/server/settings/module-page', () => ({ requireModulePage: vi.fn(async () => ({})) }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: h.queryRaw,
      request: h.request,
      document: h.document,
      invoice: h.invoice,
    }),
  ),
}));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));
vi.mock('@/components/document-preview', () => ({ DocumentPreviewButton: () => null }));
vi.mock('@/components/document-actions', () => ({ DocumentActions: () => null }));

import PortalRequestsPage from '../requests/page';
import PortalDocumentsPage from '../documents/page';
import PortalInvoicesPage from '../invoices/page';

const pages = {
  requests: PortalRequestsPage,
  documents: PortalDocumentsPage,
  invoices: PortalInvoicesPage,
} as const;

function ids(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  const rows = ids(PORTAL_LIST_PAGE_SIZE);
  h.queryRaw.mockImplementation(async (sql: Prisma.Sql) =>
    sql.sql.includes('COUNT(*)') ? [{ count: 60n }] : rows.map((id) => ({ id })),
  );
  h.request.findMany.mockResolvedValue(
    rows.map((id, index) => ({
      id,
      title: `Anforderung ${index + 1}`,
      status: 'OPEN',
      priority: 'NORMAL',
      dueAt: null,
      _count: { responses: 0 },
    })),
  );
  h.document.count.mockResolvedValue(60);
  h.document.findMany.mockResolvedValue(
    rows.map((id, index) => ({
      id,
      title: `Dokument ${index + 1}`,
      classification: 'GENERAL',
      mimeType: 'application/pdf',
      createdAt: new Date('2026-10-01T08:00:00.000Z'),
      versions: [{ sizeBytes: 1024 }],
    })),
  );
  h.invoice.count.mockResolvedValue(60);
  h.invoice.findMany.mockResolvedValue(
    rows.map((id, index) => ({
      id,
      number: `RE-${index + 1}`,
      subject: 'Beratung',
      status: 'SENT',
      issueDate: new Date('2026-10-01T00:00:00.000Z'),
      dueDate: new Date('2026-10-15T00:00:00.000Z'),
      totalAmount: 100,
      document: null,
    })),
  );
});

async function render(name: keyof typeof pages, searchParams: Record<string, string> = {}) {
  const Page = pages[name];
  return renderServer(Page({ searchParams: Promise.resolve(searchParams) }));
}

describe('Portal-Listen UX und Zugriffsscope', () => {
  it.each(Object.keys(pages) as (keyof typeof pages)[])(
    '%s nutzt serverseitige 25er-URL-Pagination, GET-Suche und mobile Karten',
    async (name) => {
      const { container } = await render(name, { page: '2' });

      const form = container.querySelector('form')!;
      expect(form.getAttribute('action')).toBe(`/portal/${name}`);
      expect(form.getAttribute('method')).toBe('get');
      // Seite 2 von 3: Links auf Seite 1 und 3 als URL-Parameter.
      const hrefs = [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
      expect(hrefs).toContain(`/portal/${name}`);
      expect(hrefs).toContain(`/portal/${name}?page=3`);
      const mobile =
        name === 'requests'
          ? container.querySelector('ul.divide-y')
          : container.querySelector('ul.md\\:hidden');
      expect(mobile?.querySelectorAll('li')).toHaveLength(PORTAL_LIST_PAGE_SIZE);
    },
  );

  it('lädt Anforderungen seitenweise und schließt persönliche über denselben Helper wie die Detailöffnung aus', async () => {
    // Fachkatalog REQ-LIFECYCLE-001: kein Titel-/Treffermengen-Leak aus dem
    // persönlichen Interaktionskanal in die mandantenweite Anforderungsliste.
    await render('requests', { q: '50%_Rabatt', page: '2' });
    const [count, list] = h.queryRaw.mock.calls.map(([sql]) => sql as Prisma.Sql);
    for (const sql of [count!, list!]) {
      expect(sql.sql).toContain('NOT app.interaction_request(r.id)');
      expect(sql.sql).toContain('strpos(lower(r.title), lower(?)) > 0');
      expect(sql.values).toContain('50%_Rabatt');
      expect(sql.values).toContain(CLIENT);
    }
    expect(list!.sql).toMatch(/LIMIT \?\s+OFFSET \?/);
    expect(list!.values.slice(-2)).toEqual([PORTAL_LIST_PAGE_SIZE, PORTAL_LIST_PAGE_SIZE]);
    const [hydrate] = h.request.findMany.mock.calls[0]!;
    expect(hydrate.where).toEqual({ clientId: CLIENT, id: { in: ids(PORTAL_LIST_PAGE_SIZE) } });
    expect(hydrate.take).toBeUndefined();
  });

  it('bindet den Dokumentfilter an Freigabe, Löschung und Lohnzugriff (DOC-PORTAL-SHARING-001)', async () => {
    await render('documents', { page: '2' });
    const [countArgs] = h.document.count.mock.calls[0]!;
    const [listArgs] = h.document.findMany.mock.calls[0]!;
    expect(countArgs.where).toEqual({
      clientId: CLIENT,
      deletedAt: null,
      sharedWithClientAt: { not: null },
      requiresPayrollAccess: false,
    });
    expect(listArgs.where).toEqual(countArgs.where);
    expect(listArgs).toMatchObject({ skip: PORTAL_LIST_PAGE_SIZE, take: PORTAL_LIST_PAGE_SIZE });
  });

  it('bindet den Rechnungsfilter an die vollständige Portalsichtbarkeit (INV-PORTAL-SHARING-001)', async () => {
    await render('invoices', { page: '2' });
    const [countArgs] = h.invoice.count.mock.calls[0]!;
    const [listArgs] = h.invoice.findMany.mock.calls[0]!;
    expect(countArgs.where).toEqual({ AND: [portalInvoiceVisibilityWhere(CLIENT)] });
    expect(JSON.stringify(countArgs.where)).not.toContain('"not":"DRAFT"');
    expect(listArgs.where).toEqual(countArgs.where);
    expect(listArgs).toMatchObject({ skip: PORTAL_LIST_PAGE_SIZE, take: PORTAL_LIST_PAGE_SIZE });
    expect(screen.getAllByText('RE-1').length).toBeGreaterThan(0);
  });
});
