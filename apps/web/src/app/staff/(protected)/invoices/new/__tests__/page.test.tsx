// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-STAFF-PERMISSION-001
import type { StaffSession } from '@/server/auth/staff';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/server/settings/modules', () => ({
  readModules: async () => ({ invoiceMode: fixture.mode }),
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
vi.mock('../form', () => ({
  NewInvoiceForm: (props: Record<string, unknown>) =>
    'Rechnungsformular' + (Object.keys(props).length ? ' mit Props' : ''),
}));
vi.mock('../external-form', () => ({
  ExternalInvoiceForm: (props: Record<string, unknown>) =>
    'Uploadformular: ' + Object.keys(props).join(','),
}));
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
      expect(html).not.toContain('formular:');
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
    ['IN_APP', 'Rechnungsformular'],
    ['EXTERNAL', 'Uploadformular: categories'],
  ])(
    'zeigt bei zugänglichen Mandanten weiterhin das %s-Formular ohne vorgeladenen Bestand',
    async (mode, form) => {
      fixture.mode = mode;
      fixture.firstClient = { id: 'visible' };
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain(form);
      expect(html).not.toContain('mit Props');
      expect(html).not.toContain('Kein auswählbarer Mandant');
    },
  );
});
