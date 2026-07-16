import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConsentOptionsCatalog } from '@/server/privacy/consent';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  revalidatePath: vi.fn(),
  writePrivacyConfigTx: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/actions/staff-action', async () => {
  const { parseFormData } = await import('@/server/actions/form-data');
  class ActionError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ActionError';
    }
  }
  return { ActionError, parseFormData, staffActionGuard: mocks.staffActionGuard };
});
vi.mock('@/server/auth/rbac', () => ({
  toActionError: (error: unknown) => ({
    ok: false,
    error:
      error instanceof Error && error.name === 'ActionError'
        ? error.message
        : 'Aktion fehlgeschlagen. Bitte erneut versuchen.',
  }),
}));
vi.mock('@/server/privacy/notice', () => ({ writePrivacyConfigTx: mocks.writePrivacyConfigTx }));

import { saveConsentOptionsAction, savePrivacyConfigAction } from '../actions';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: '11111111-1111-4111-8111-111111111111',
    staffId: '22222222-2222-4222-8222-222222222222',
    ctx: { tenantId: '11111111-1111-4111-8111-111111111111' },
  });
});

describe('savePrivacyConfigAction', () => {
  it('schreibt Hinweis und Audit atomar unter demselben Display-CAS-Lock', async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    const formData = new FormData();
    formData.set('responsibleBody', 'Musterkanzlei, Musterstraße 1');
    formData.set('supervisoryAuthority', 'Aufsichtsbehörde');
    formData.set('privacyContact', 'datenschutz@example.test');

    const result = await savePrivacyConfigAction(null, formData);

    expect(result).toEqual({ ok: true });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(mocks.writePrivacyConfigTx).toHaveBeenCalledWith(
      tx,
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({
        responsibleBody: 'Musterkanzlei, Musterstraße 1',
        supervisoryAuthority: 'Aufsichtsbehörde',
        privacyContact: 'datenschutz@example.test',
      }),
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writePrivacyConfigTx.mock.invocationCallOrder[0]!,
    );
    expect(mocks.writePrivacyConfigTx.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.evidenceRecord.mock.invocationCallOrder[0]!,
    );
  });
});

describe('saveConsentOptionsAction', () => {
  it('ersetzt einen korrupten Bestandskatalog über den expliziten ACP-Reparaturpfad', async () => {
    const revision = new Date('2026-07-15T10:00:00.000Z');
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      tenantSetting: {
        findUnique: vi.fn().mockResolvedValue({
          value: { version: 99, broken: true },
          updatedAt: revision,
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      serviceProvider: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    const catalog = defaultConsentOptionsCatalog();
    const customOptionId = 'd37f61f0-6a73-4d5a-b2fd-e15c2389ec52';
    catalog.options.push({
      id: customOptionId,
      builtin: false,
      section: 'OTHER',
      label: 'Notwendige Bestätigung',
      description: 'Exakt auditierte Erläuterung',
      active: true,
      required: true,
      recommended: true,
      sortOrder: 1000,
      serviceProviderId: null,
    });
    const formData = new FormData();
    formData.set('catalogJson', JSON.stringify(catalog));
    formData.set('expectedRevision', revision.toISOString());

    const result = await saveConsentOptionsAction(null, formData);

    expect(result).toEqual({ ok: true });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.tenantSetting.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        key: 'privacy.consent_options',
        updatedAt: revision,
      },
      data: expect.objectContaining({
        updatedBy: '22222222-2222-4222-8222-222222222222',
        value: expect.objectContaining({
          version: 2,
          options: expect.arrayContaining([
            expect.objectContaining({
              id: customOptionId,
              required: true,
              recommended: true,
            }),
          ]),
        }),
      }),
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'privacy.consent_options.update',
        before: {
          invalidStoredCatalog: true,
          storedValue: { version: 99, broken: true },
        },
        after: expect.objectContaining({
          options: expect.arrayContaining([
            expect.objectContaining({
              id: customOptionId,
              description: 'Exakt auditierte Erläuterung',
            }),
          ]),
        }),
      }),
    );
  });

  it('weist einen veralteten Browser-Stand konfliktfrei zurück', async () => {
    const currentRevision = new Date('2026-07-15T10:01:00.000Z');
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      tenantSetting: {
        findUnique: vi.fn().mockResolvedValue({
          value: defaultConsentOptionsCatalog(),
          updatedAt: currentRevision,
        }),
        updateMany: vi.fn(),
      },
      serviceProvider: { findMany: vi.fn() },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: typeof tx) => unknown) => fn(tx),
    );
    const formData = new FormData();
    formData.set('catalogJson', JSON.stringify(defaultConsentOptionsCatalog()));
    formData.set('expectedRevision', '2026-07-15T10:00:00.000Z');

    const result = await saveConsentOptionsAction(null, formData);

    expect(result).toEqual({
      ok: false,
      error:
        'Der Einwilligungskatalog wurde zwischenzeitlich geändert. Bitte Seite neu laden und Änderungen erneut prüfen.',
    });
    expect(tx.tenantSetting.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
});
