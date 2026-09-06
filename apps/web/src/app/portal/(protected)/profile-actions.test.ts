import { beforeEach, describe, expect, it, vi } from 'vitest';
// Fachkatalog: ACCESS-TENANT-RLS-001.

const m = vi.hoisted(() => ({
  portalAuth: vi.fn(),
  withTenantContext: vi.fn(),
  resolveSwitch: vi.fn(),
  writeSession: vi.fn(),
  evidenceRecord: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: m.portalAuth }));
vi.mock('@/server/auth/portal-profiles', () => ({
  resolvePortalProfileSwitchTx: m.resolveSwitch,
}));
vi.mock('@/server/auth/portal-session', () => ({ writePortalSession: m.writeSession }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.evidenceRecord } }));

import { switchPortalProfileAction } from './profile-actions';

const CURRENT_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

describe('Portal-Profilwechsel', () => {
  const tx = { clientContact: { update: vi.fn() } };

  beforeEach(() => {
    vi.clearAllMocks();
    m.portalAuth.mockResolvedValue({
      user: {
        tenantId: 'tenant-1',
        contactId: CURRENT_ID,
        email: 'rey@example.test',
        sessionIssuedAt: 1_783_333_333,
        sessionOriginContactId: CURRENT_ID,
      },
    });
    m.withTenantContext.mockImplementation(
      async (_ctx: unknown, run: (client: typeof tx) => Promise<unknown>) => run(tx),
    );
    m.resolveSwitch.mockResolvedValue({
      contactId: TARGET_ID,
      clientId: '33333333-3333-4333-8333-333333333333',
      clientName: 'Hirschmann & Koxha GbR',
      contactName: 'Rey Koxha',
      email: 'rey@example.test',
    });
  });

  it('schreibt Session und Audit nur fuer ein serverseitig aufgeloestes Schwesterprofil', async () => {
    const data = new FormData();
    data.set('contactId', TARGET_ID);

    await expect(switchPortalProfileAction(data)).rejects.toThrow('REDIRECT:/portal/dashboard');

    expect(m.resolveSwitch).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      currentContactId: CURRENT_ID,
      email: 'rey@example.test',
      targetContactId: TARGET_ID,
    });
    expect(m.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'auth.portal.profile.switch',
        actorId: CURRENT_ID,
        resourceId: TARGET_ID,
      }),
    );
    expect(m.writeSession).toHaveBeenCalledWith(
      {
        id: TARGET_ID,
        tenantId: 'tenant-1',
        clientId: '33333333-3333-4333-8333-333333333333',
        email: 'rey@example.test',
        fullName: 'Rey Koxha',
      },
      { sessionIssuedAt: 1_783_333_333, sessionOriginContactId: CURRENT_ID },
    );
  });

  it('veraendert bei einem unzulaessigen Ziel weder Session noch Audit', async () => {
    m.resolveSwitch.mockResolvedValue(null);
    const data = new FormData();
    data.set('contactId', TARGET_ID);

    await expect(switchPortalProfileAction(data)).rejects.toThrow('REDIRECT:/portal/dashboard');

    expect(m.writeSession).not.toHaveBeenCalled();
    expect(m.evidenceRecord).not.toHaveBeenCalled();
  });
});
