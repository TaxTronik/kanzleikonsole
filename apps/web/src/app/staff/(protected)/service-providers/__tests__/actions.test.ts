import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConsentOptionsCatalog } from '@/server/privacy/consent';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const PROVIDER_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  evidenceRecord: vi.fn(),
  logError: vi.fn(),
  revalidatePath: vi.fn(),
  staffAuth: vi.fn(),
  withTenantContext: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: mocks.withTenantContext,
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: mocks.staffAuth }));
vi.mock('@/server/container', () => ({
  evidenceService: { record: mocks.evidenceRecord },
}));
vi.mock('@/server/logger', () => ({
  log: { error: mocks.logError },
}));

import { deleteServiceProviderAction } from '../actions';

function formData(): FormData {
  const form = new FormData();
  form.set('id', PROVIDER_ID);
  return form;
}

function makeTx(catalogValue: unknown) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    serviceProvider: {
      findUnique: vi.fn().mockResolvedValue({
        id: PROVIDER_ID,
        name: 'Cloud-Dienstleister',
        category: 'Hosting',
      }),
      delete: vi.fn().mockResolvedValue({ id: PROVIDER_ID }),
    },
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue(
        catalogValue === null
          ? null
          : {
              value: catalogValue,
            },
      ),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffAuth.mockResolvedValue({
    user: {
      id: STAFF_ID,
      tenantId: TENANT_ID,
      staffId: STAFF_ID,
      roles: ['ADMIN'],
      permissions: [],
    },
  });
  mocks.evidenceRecord.mockResolvedValue({});
});

describe('deleteServiceProviderAction', () => {
  it('blockiert das Löschen, solange eine Einwilligungsoption verknüpft ist', async () => {
    const catalog = defaultConsentOptionsCatalog();
    catalog.options[0] = { ...catalog.options[0]!, serviceProviderId: PROVIDER_ID };
    const tx = makeTx(catalog);
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (transaction: typeof tx) => unknown) => callback(tx),
    );

    const result = await deleteServiceProviderAction(null, formData());

    expect(result).toEqual({
      ok: false,
      error:
        'Dienstleister ist mit „Mandantenportal / sicherer Datenraum“ verknüpft. Bitte die Verknüpfung zuerst unter Administration → Datenschutz entfernen.',
    });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_key: { tenantId: TENANT_ID, key: 'privacy.consent_options' },
      },
      select: { value: true },
    });
    expect(tx.serviceProvider.delete).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('löscht einen unverknüpften Dienstleister nach dem gemeinsamen Katalog-Lock', async () => {
    const tx = makeTx(defaultConsentOptionsCatalog());
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (transaction: typeof tx) => unknown) => callback(tx),
    );

    const result = await deleteServiceProviderAction(null, formData());

    expect(result).toEqual({ ok: true });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.serviceProvider.delete).toHaveBeenCalledWith({ where: { id: PROVIDER_ID } });
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tenantSetting.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(tx.tenantSetting.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      tx.serviceProvider.delete.mock.invocationCallOrder[0]!,
    );
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(tx, {
      tenantId: TENANT_ID,
      actorType: 'STAFF',
      actorId: STAFF_ID,
      action: 'service_provider.delete',
      resourceType: 'service_provider',
      resourceId: PROVIDER_ID,
      before: { name: 'Cloud-Dienstleister', category: 'Hosting' },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/staff/service-providers');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/staff/admin/privacy');
  });

  it('gibt unerwartete Datenbankdetails nicht an die UI weiter', async () => {
    const tx = makeTx(defaultConsentOptionsCatalog());
    tx.serviceProvider.findUnique.mockRejectedValue(
      new Error('postgres://secret-user:secret-password@internal-db/provider'),
    );
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, callback: (transaction: typeof tx) => unknown) => callback(tx),
    );

    const result = await deleteServiceProviderAction(null, formData());

    expect(result).toEqual({
      ok: false,
      error: 'Unerwarteter Fehler. Bitte erneut versuchen oder Admin kontaktieren.',
    });
    expect(result.error).not.toContain('secret-password');
    expect(mocks.logError).toHaveBeenCalledOnce();
    expect(tx.serviceProvider.delete).not.toHaveBeenCalled();
  });
});
