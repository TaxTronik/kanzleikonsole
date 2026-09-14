// Fachkatalog: CLIENT-ASSISTANCE-001, ACCESS-CLIENT-MODE-001, ACCESS-STAFF-PERMISSION-001
import type { StaffSession } from '@/server/auth/staff';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  session: {} as StaffSession,
  findMany: vi.fn(),
  access: vi.fn(async () => ({ id: { in: ['visible'] } })),
}));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: async () => ({
    ok: true,
    staffId: 'staff-test',
    tenantId: 'tenant-test',
    session: fixture.session,
    ctx: { tenantId: 'tenant-test', actorId: 'staff-test', actorType: 'STAFF' },
  }),
}));
vi.mock('@/server/actions/portal-action', () => ({ portalActionGuard: vi.fn() }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: vi.fn() }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/auth/rbac', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/auth/rbac')>()),
  accessibleClientsWhereFor: fixture.access,
}));
vi.mock('@/server/settings/modules', () => ({
  readModules: async () => ({ expenseAssistance: true, clientProcedures: true }),
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({ client: { findMany: fixture.findMany } }),
}));
vi.mock('../service', () => ({ withAssistance: vi.fn(), assistanceDocumentWhere: vi.fn() }));
vi.mock('@/components/client-assistance-form', () => ({ ClientAssistanceForm: () => null }));
vi.mock('@/components/expansion-form', () => ({ ExpansionForm: () => null }));
import { AssistancePage } from '../page';

async function renderPage() {
  const action = async () => ({ ok: true });
  return renderToStaticMarkup(
    await AssistancePage({
      surface: 'staff',
      search: {},
      saveAction: action,
      archiveAction: action,
      reimportAction: action,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.session = {
    expires: '2099-01-01T00:00:00.000Z',
    user: {
      id: 'staff-test',
      email: 'staff@example.test',
      name: 'Testkonto',
      fullName: 'Testkonto',
      tenantId: 'tenant-test',
      staffId: 'staff-test',
      roles: ['EMPLOYEE'],
      permissions: [],
    },
  };
  fixture.findMany.mockResolvedValue([]);
});

describe('Assistenten ohne zugänglichen Mandanten', () => {
  it('erklärt die Voraussetzung ohne leere Auswahl oder globale Bestandsbehauptung', async () => {
    const html = await renderPage();
    expect(html).toContain('Kein auswählbarer Mandant');
    expect(html).toContain('href="/staff/clients"');
    expect(html).not.toContain('/staff/clients/onboarding/new');
    expect(html).not.toContain('<ul');
    expect(html).not.toMatch(/keine Mandanten vorhanden|versteckt|vertraulich/i);
    expect(fixture.findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          id: { in: ['visible'] },
          tenantId: 'tenant-test',
          allowActive: true,
          anonymizedAt: null,
          mandateEndedAt: null,
        },
      }),
    );
  });

  it.each(['grant', 'admin'] as const)(
    'zeigt Aufnahme nur mit Berechtigung (%s)',
    async (permission) => {
      if (permission === 'admin') fixture.session.user.roles = ['ADMIN'];
      else fixture.session.user.permissions.push('CLIENT_CREATE');
      expect(await renderPage()).toContain('href="/staff/clients/onboarding/new"');
    },
  );

  it('behält die gefilterte Auswahl mit verfügbaren Mandanten bei', async () => {
    fixture.findMany.mockResolvedValue([{ id: 'visible', name: 'Sichtbarer Mandant' }]);
    const html = await renderPage();
    expect(html).toContain('href="/staff/client-assistance?clientId=visible"');
    expect(html).toContain('Sichtbarer Mandant');
    expect(html).not.toContain('Kein auswählbarer Mandant');
  });
});
