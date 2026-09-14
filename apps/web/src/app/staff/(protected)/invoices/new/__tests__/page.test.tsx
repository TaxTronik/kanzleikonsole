// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-STAFF-PERMISSION-001
import type { StaffSession } from '@/server/auth/staff';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  session: {} as StaffSession,
  clients: [] as Array<{ id: string; name: string }>,
  mode: 'IN_APP',
  accessMode: 'RESTRICTED',
  findMany: vi.fn(),
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
    run({ client: { findMany: fixture.findMany }, invoiceCategory: { findMany: async () => [] } }),
}));
vi.mock('../form', () => ({
  NewInvoiceForm: ({ clients }: { clients: Array<{ name: string }> }) =>
    'Rechnungsformular: ' + clients.map((c) => c.name).join(', '),
}));
vi.mock('../external-form', () => ({
  ExternalInvoiceForm: ({ clients }: { clients: Array<{ name: string }> }) =>
    'Uploadformular: ' + clients.map((c) => c.name).join(', '),
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
  fixture.clients = [];
  fixture.findMany.mockImplementation(async () => fixture.clients);
});

describe('Rechnungsanlage — ACCESS-CLIENT-MODE-001', () => {
  it.each(['IN_APP', 'EXTERNAL'])(
    'wendet in %s die echte RESTRICTED-Policy vor der Auswahl an',
    async (mode) => {
      fixture.mode = mode;
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(fixture.findMany).toHaveBeenCalledExactlyOnceWith({
        where: {
          allowActive: true,
          responsibilities: {
            some: { staffId: 'staff-test', role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
          },
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
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
    expect(fixture.findMany.mock.calls[0]![0].where).toEqual({
      allowActive: true,
      OR: [
        { vertraulich: false },
        {
          responsibilities: {
            some: { staffId: 'staff-test', role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
          },
        },
      ],
    });
  });

  it.each(['ADMIN', 'PARTNER'] as const)(
    'behält %s-Zugriff und den Aufnahmeweg bei',
    async (role) => {
      fixture.session.user.roles = [role];
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(fixture.findMany.mock.calls[0]![0].where).toEqual({ allowActive: true });
      expect(html).toContain('href="/staff/clients/onboarding/new"');
    },
  );

  it('bietet die Aufnahme auch mit ausdrücklichem CLIENT_CREATE-Grant an', async () => {
    fixture.session.user.permissions.push('CLIENT_CREATE');
    expect(renderToStaticMarkup(await NewInvoicePage())).toContain('/staff/clients/onboarding/new');
  });

  it.each(['IN_APP', 'EXTERNAL'])(
    'zeigt bei zugänglichen Mandanten weiterhin das %s-Formular',
    async (mode) => {
      fixture.mode = mode;
      fixture.clients = [{ id: 'visible', name: 'Sichtbarer Mandant' }];
      const html = renderToStaticMarkup(await NewInvoicePage());
      expect(html).toContain('formular: Sichtbarer Mandant');
      expect(html).not.toContain('Kein auswählbarer Mandant');
    },
  );
});
