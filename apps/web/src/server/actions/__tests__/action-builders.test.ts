// Review-Befund K-02: staffAction/portalAction sind an die echten Gates
// gebunden (Session, Rolle/Einzelrecht, Modul) und reichen denselben Kontext an
// `run` wie withStaff/withPortalContext an ihren Callback. `deniedMessage`
// ersetzt die von Hand nachgebauten Rollenprüfungen mit eigener Meldung.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ModuleDisabledError: class ModuleDisabledError extends Error {},
  staffAuth: vi.fn(),
  portalAuth: vi.fn(),
  isStaffAdmin: vi.fn(),
  hasStaffPermission: vi.fn(),
  assertModuleEnabled: vi.fn(),
  withTenantContext: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db/tenant-context', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/auth/staff', () => ({ staffAuth: h.staffAuth }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: h.portalAuth }));
vi.mock('@/server/auth/rbac', async () => ({
  ...(await import('@/server/actions/to-action-error')),
  isStaffAdmin: h.isStaffAdmin,
  hasStaffPermission: h.hasStaffPermission,
}));
vi.mock('@/server/settings/modules', () => ({
  assertModuleEnabled: h.assertModuleEnabled,
  readModules: vi.fn(),
  isModeModuleEnabled: vi.fn(),
  ModuleDisabledError: h.ModuleDisabledError,
}));

import { ActionError } from '../action-error';
import { staffAction, staffActionGuard, withStaff } from '../staff-action';
import { portalAction } from '../portal-action';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const CONTACT_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  vi.clearAllMocks();
  h.staffAuth.mockResolvedValue({ user: { tenantId: TENANT_ID, staffId: STAFF_ID } });
  h.portalAuth.mockResolvedValue({
    user: { tenantId: TENANT_ID, contactId: CONTACT_ID, clientId: CLIENT_ID },
  });
  h.isStaffAdmin.mockReturnValue(false);
  h.hasStaffPermission.mockReturnValue(false);
  h.assertModuleEnabled.mockResolvedValue(undefined);
  h.withTenantContext.mockImplementation(async (_ctx, fn: (tx: object) => unknown) => fn({}));
});

describe('staffActionGuard — deniedMessage', () => {
  it('ersetzt die Rollen-Ablehnung durch die präzisere Meldung', async () => {
    await expect(staffActionGuard({ requireAdmin: true })).resolves.toEqual({
      ok: false,
      error: 'Nur ADMIN/PARTNER.',
    });
    await expect(
      staffActionGuard({ requireAdmin: true, deniedMessage: 'Nur ADMIN/PARTNER darf das.' }),
    ).resolves.toEqual({ ok: false, error: 'Nur ADMIN/PARTNER darf das.' });
  });

  it('ersetzt die Einzelrecht-Ablehnung durch die präzisere Meldung', async () => {
    await expect(
      staffActionGuard({ requirePermission: 'INVOICE_SEND', deniedMessage: 'Kein Versand.' }),
    ).resolves.toEqual({ ok: false, error: 'Kein Versand.' });
  });

  it('meldet ohne Session weiterhin „Nicht eingeloggt."', async () => {
    h.staffAuth.mockResolvedValue(null);
    await expect(
      staffActionGuard({ requireAdmin: true, deniedMessage: 'Nur ADMIN/PARTNER darf das.' }),
    ).resolves.toEqual({ ok: false, error: 'Nicht eingeloggt.' });
  });

  it('lässt berechtigte Personen mit deniedMessage unverändert durch', async () => {
    h.isStaffAdmin.mockReturnValue(true);
    await expect(
      staffActionGuard({ requireAdmin: true, deniedMessage: 'Nur ADMIN/PARTNER darf das.' }),
    ).resolves.toMatchObject({ ok: true, tenantId: TENANT_ID, staffId: STAFF_ID });
  });
});

describe('staffAction — an das Staff-Gate gebunden', () => {
  it('führt run ohne Rolle nicht aus und prüft die Eingabe nicht', async () => {
    const parse = vi.fn();
    const run = vi.fn();

    await expect(
      staffAction({ guard: { requireAdmin: true, deniedMessage: 'Nur Admin.' }, parse, run }),
    ).resolves.toEqual({ ok: false, error: 'Nur Admin.' });
    expect(parse).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('blockiert ein deaktiviertes Modul vor run', async () => {
    h.assertModuleEnabled.mockRejectedValue(
      new h.ModuleDisabledError('Das Modul Formulare ist deaktiviert.'),
    );
    const run = vi.fn();

    await expect(staffAction({ guard: { module: 'forms' }, run })).resolves.toEqual({
      ok: false,
      error: 'Das Modul Formulare ist deaktiviert.',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('reicht denselben Staff-Kontext wie withStaff an run', async () => {
    const seen: unknown[] = [];
    await staffAction({ run: async (g) => void seen.push(g) });
    await withStaff(async (_tx, g) => void seen.push(g));

    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toMatchObject({
      tenantId: TENANT_ID,
      staffId: STAFF_ID,
      ctx: { tenantId: TENANT_ID, actorId: STAFF_ID, actorType: 'STAFF' },
    });
  });

  it('mappt Fachfehler aus run und revalidiert nur nach Erfolg', async () => {
    await expect(
      staffAction({
        run: async () => {
          throw new ActionError('Mandant nicht gefunden.');
        },
        revalidate: '/staff/clients',
      }),
    ).resolves.toEqual({ ok: false, error: 'Mandant nicht gefunden.' });
    expect(h.revalidatePath).not.toHaveBeenCalled();

    await expect(
      staffAction({ run: async () => ({ savedAt: 'jetzt' }), revalidate: '/staff/clients' }),
    ).resolves.toEqual({ ok: true, savedAt: 'jetzt' });
    expect(h.revalidatePath).toHaveBeenCalledWith('/staff/clients');
  });
});

describe('portalAction — an das Portal-Gate gebunden', () => {
  it('reicht den Kontakt-Kontext an run und blockiert ohne Session', async () => {
    const run = vi.fn(async () => undefined);
    await expect(portalAction({ run })).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        clientId: CLIENT_ID,
        ctx: { tenantId: TENANT_ID, actorId: CONTACT_ID, actorType: 'CLIENT_CONTACT' },
      }),
      undefined,
    );

    h.portalAuth.mockResolvedValue(null);
    run.mockClear();
    await expect(portalAction({ run })).resolves.toEqual({ ok: false, error: 'Nicht eingeloggt.' });
    expect(run).not.toHaveBeenCalled();
  });
});
