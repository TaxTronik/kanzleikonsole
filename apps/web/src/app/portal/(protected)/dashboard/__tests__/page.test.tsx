// Review-Befund F-14: Die Badges der Portal-Startseite zählen per count() mit
// exakt den Filtern der dort gekappten Listen; gekappte Listen zeigen einen
// Hinweis mit Link auf die vollständige Liste.

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  modules: { forms: true, invoiceMode: 'FULL' },
  tx: {
    request: { count: vi.fn(), findMany: vi.fn() },
    document: { count: vi.fn() },
    formSubmission: { count: vi.fn(), findMany: vi.fn() },
    invoice: { count: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('next/navigation', () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));
vi.mock('@/server/auth/portal', () => ({
  portalAuth: vi.fn(async () => ({
    user: {
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      clientId: 'client-1',
      fullName: 'Erika Mustermann',
    },
  })),
}));
vi.mock('@/server/settings/modules', () => ({ readModules: vi.fn(async () => h.modules) }));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeatures: vi.fn(async () => ({ clientInbox: false })),
}));
vi.mock('@/server/inbox/queries', () => ({ countPortalInboxNeedsClientTx: vi.fn() }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (tx: typeof h.tx) => unknown) => fn(h.tx)),
}));

import PortalDashboardPage from '../page';

function rows(count: number, make: (index: number) => Record<string, unknown>) {
  return Array.from({ length: count }, (_, index) => make(index));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.modules = { forms: true, invoiceMode: 'FULL' };
  h.tx.request.count.mockResolvedValue(14);
  h.tx.request.findMany.mockImplementation(async (args: { take: number }) =>
    rows(Math.min(args.take, 14), (i) => ({
      id: `req-${i}`,
      title: `Anforderung ${i}`,
      status: 'OPEN',
      dueAt: null,
    })),
  );
  h.tx.document.count.mockResolvedValue(3);
  h.tx.formSubmission.count.mockResolvedValue(12);
  h.tx.formSubmission.findMany.mockResolvedValue(
    rows(10, (i) => ({ id: `form-${i}`, template: { name: `Formular ${i}` } })),
  );
  h.tx.invoice.count.mockResolvedValue(7);
  h.tx.invoice.findMany.mockResolvedValue(
    rows(5, (i) => ({
      id: `inv-${i}`,
      number: `RE-${i}`,
      dueDate: new Date('2026-10-20T00:00:00.000Z'),
      totalAmount: { toString: () => '119.00' },
      status: 'SENT',
    })),
  );
});

describe('Portal-Startseite — Zähler gekappter Listen', () => {
  it('zählt „offen“ vollständig und verweist auf die vollständigen Listen', async () => {
    const html = renderToStaticMarkup(await PortalDashboardPage());

    expect(html).toContain('<span class="badge-yellow ml-auto">26 offen</span>');
    expect(html).toContain('20 von 26 angezeigt');
    expect(html).toContain('href="/portal/requests"');
    expect(html).toContain('>Alle Anforderungen</a>');
    expect(html).toContain('>Alle Formulare</a>');
    expect(html).toContain('<span class="badge-yellow">7</span>');
    expect(html).toContain('5 von 7 angezeigt');
  });

  it('verwendet für jeden Zähler exakt den Filter der zugehörigen Liste', async () => {
    await PortalDashboardPage();

    const requestCountWhere = h.tx.request.count.mock.calls[0]![0].where;
    const todoRequestArgs = h.tx.request.findMany.mock.calls.find(([args]) => args.take === 10)![0];
    expect(todoRequestArgs.where).toEqual(requestCountWhere);
    expect(requestCountWhere).toEqual({
      clientId: 'client-1',
      status: { in: ['OPEN', 'IN_PROGRESS'] },
    });
    expect(h.tx.formSubmission.findMany.mock.calls[0]![0].where).toEqual(
      h.tx.formSubmission.count.mock.calls[0]![0].where,
    );
    expect(h.tx.invoice.findMany.mock.calls[0]![0].where).toEqual(
      h.tx.invoice.count.mock.calls[0]![0].where,
    );
  });

  it('zeigt ohne Kappung keinen Ausschnitt-Hinweis', async () => {
    h.tx.request.count.mockResolvedValue(2);
    h.tx.formSubmission.count.mockResolvedValue(1);
    h.tx.formSubmission.findMany.mockResolvedValue(
      rows(1, (i) => ({ id: `form-${i}`, template: { name: 'Formular' } })),
    );
    h.tx.invoice.count.mockResolvedValue(5);

    const html = renderToStaticMarkup(await PortalDashboardPage());

    expect(html).toContain('3 offen</span>');
    expect(html).not.toContain('angezeigt');
  });

  it('fragt bei abgeschaltetem Formular- und Rechnungsmodul weder Listen noch Zähler ab', async () => {
    h.modules = { forms: false, invoiceMode: 'OFF' };

    const html = renderToStaticMarkup(await PortalDashboardPage());

    expect(h.tx.formSubmission.count).not.toHaveBeenCalled();
    expect(h.tx.formSubmission.findMany).not.toHaveBeenCalled();
    expect(h.tx.invoice.count).not.toHaveBeenCalled();
    expect(html).toContain('14 offen</span>');
    expect(html).toContain('10 von 14 angezeigt');
    expect(html).not.toContain('Alle Formulare');
  });
});
