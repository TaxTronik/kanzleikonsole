// @vitest-environment jsdom
// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-STAFF-PERMISSION-001, INV-NUMBER-ALLOCATION-001
import type { StaffSession } from '@/server/auth/staff';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  session: {} as StaffSession,
  firstClient: null as { id: string } | null,
  mode: 'IN_APP',
  accessMode: 'RESTRICTED',
  findFirst: vi.fn(),
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: async () => fixture.session }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/settings/access-policy', () => ({
  readAccessPolicyTx: async () => ({ clientAccessMode: fixture.accessMode }),
}));
vi.mock('@/server/settings/module-page', () => ({
  requireModulePage: async () => ({ invoiceMode: fixture.mode }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({
      client: { findFirst: fixture.findFirst },
      invoiceCategory: { findMany: async () => [] },
    }),
}));
// Die Formulare suchen Mandanten selbst serverseitig (ClientCombobox); die
// Seite übergibt keinen Bestand mehr.
vi.mock('../form', { spy: true });
vi.mock('../external-form', { spy: true });
vi.mock('../../actions', () => ({
  createInvoiceAction: vi.fn(),
  uploadExternalInvoiceAction: vi.fn(),
}));
vi.mock('next/navigation', async (original) => ({
  ...(await original<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
import { NewInvoiceForm } from '../form';
import { ExternalInvoiceForm } from '../external-form';
import NewInvoicePage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.mode = 'IN_APP';
  fixture.accessMode = 'RESTRICTED';
  fixture.session = {
    user: {
      tenantId: 'tenant-test',
      staffId: 'staff-test',
      roles: ['EMPLOYEE'],
      permissions: ['INVOICE_MANAGE', 'INVOICE_SEND'],
    },
  } as StaffSession;
  fixture.firstClient = null;
  fixture.findFirst.mockImplementation(async () => fixture.firstClient);
});

afterEach(() => vi.useRealTimers());

// Gleiche Zugriffsregel wie die Suche: Tenant + accessibleClientsWhereFor + allowActive.
const where = (access: Record<string, unknown>) => ({
  AND: [{ tenantId: 'tenant-test' }, access, { allowActive: true }],
});
const RESTRICTED_ACCESS = {
  responsibilities: {
    some: { staffId: 'staff-test', role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
  },
};

describe('Rechnungsanlage — ACCESS-CLIENT-MODE-001', () => {
  it.each(['IN_APP', 'EXTERNAL'])(
    'wendet in %s die echte RESTRICTED-Policy vor der Auswahl an',
    async (mode) => {
      fixture.mode = mode;
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(fixture.findFirst).toHaveBeenCalledExactlyOnceWith({
        where: where(RESTRICTED_ACCESS),
        select: { id: true },
      });
      expect(html).toContain('Kein auswählbarer Mandant');
      expect(html).toContain('href="/staff/clients"');
      expect(html).not.toContain('/staff/clients/onboarding/new');
      expect(html).not.toContain('id="issueDate"');
      expect(html).not.toContain('Keine aktiven Mandanten vorhanden');
    },
  );

  it('behält in OPEN das Vertraulichkeitsventil bei', async () => {
    fixture.accessMode = 'OPEN';
    await NewInvoicePage();
    expect(fixture.findFirst.mock.calls[0]![0].where).toEqual(
      where({ OR: [{ vertraulich: false }, RESTRICTED_ACCESS] }),
    );
  });

  it.each(['ADMIN', 'PARTNER'] as const)(
    'behält %s-Zugriff und den Aufnahmeweg bei',
    async (role) => {
      fixture.session.user.roles = [role];
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(fixture.findFirst.mock.calls[0]![0].where).toEqual(where({}));
      expect(html).toContain('href="/staff/clients/onboarding/new"');
    },
  );

  it('bietet die Aufnahme auch mit ausdrücklichem CLIENT_CREATE-Grant an', async () => {
    fixture.session.user.permissions.push('CLIENT_CREATE');
    expect(renderToStaticMarkup(await NewInvoicePage())).toContain('/staff/clients/onboarding/new');
  });

  it.each([
    ['IN_APP', NewInvoiceForm],
    ['EXTERNAL', ExternalInvoiceForm],
  ])(
    'zeigt bei zugänglichen Mandanten weiterhin das %s-Formular ohne vorgeladenen Bestand',
    async (mode, form) => {
      fixture.mode = mode;
      fixture.firstClient = { id: 'visible' };
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('id="issueDate"');
      const props = vi.mocked(form).mock.lastCall?.[0];
      expect(Object.keys(props ?? {}).sort()).toEqual(
        mode === 'IN_APP'
          ? ['initialDueDate', 'initialIssueDate']
          : ['categories', 'initialDueDate', 'initialIssueDate'],
      );
      expect(html).not.toContain('Kein auswählbarer Mandant');
    },
  );
});

describe('Datumsfelder bei der Rechnungsanlage (INV-NUMBER-ALLOCATION-001)', () => {
  it.each([
    ['IN_APP', '2026-03-28T23:30:00Z', '2026-03-29', '2026-04-28'],
    ['EXTERNAL', '2026-03-28T23:30:00Z', '2026-03-29', '2026-04-12'],
    ['IN_APP', '2026-10-24T22:30:00Z', '2026-10-25', '2026-11-24'],
    ['EXTERNAL', '2026-10-24T22:30:00Z', '2026-10-25', '2026-11-08'],
    ['IN_APP', '2026-12-31T23:30:00Z', '2027-01-01', '2027-01-31'],
    ['EXTERNAL', '2026-12-31T23:30:00Z', '2027-01-01', '2027-01-15'],
  ])(
    'zeigt in %s um %s Rechnungsdatum und Fälligkeit vor der Eingabe',
    async (mode, now, issue, due) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      fixture.mode = mode;
      fixture.firstClient = { id: 'visible' };
      render(await NewInvoicePage());
      expect(screen.getByLabelText<HTMLInputElement>(/^Rechnungsdatum/).value).toBe(issue);
      expect(screen.getByLabelText<HTMLInputElement>(/^Fällig am/).value).toBe(due);
    },
  );
});
