import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  assertPublicUrl: vi.fn(),
  tsaTimestamp: vi.fn(),
  tsaVerify: vi.fn(),
  createRfc3161Adapter: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/config', () => ({ env: { NODE_ENV: 'test' } }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));
vi.mock('@/server/http/ssrf-guard', () => ({ assertPublicUrl: mocks.assertPublicUrl }));
vi.mock('@/server/settings/tax-region', () => ({ writeTaxRegion: vi.fn() }));
vi.mock('@/server/settings/tsa', () => ({ writeTsaConfig: vi.fn() }));
vi.mock('@/server/actions/staff-action', () => ({
  staffActionGuard: mocks.staffActionGuard,
}));
vi.mock('@taxtronik/evidence', () => ({
  createRfc3161Adapter: mocks.createRfc3161Adapter,
  getTsaProvider: vi.fn(() => undefined),
}));

import { testTsaAction } from '../infra-actions';

function customTsaForm(): FormData {
  const formData = new FormData();
  formData.set('providerId', 'custom');
  formData.set('customUrl', 'https://tsa.example.test/tsr');
  return formData;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  mocks.assertPublicUrl.mockResolvedValue(undefined);
  mocks.tsaTimestamp.mockResolvedValue({
    timestampedAt: '2026-08-23T12:00:00.000Z',
    tsaResponseBlob: Buffer.from('trusted-token'),
  });
  mocks.tsaVerify.mockResolvedValue(true);
  mocks.createRfc3161Adapter.mockReturnValue({
    timestamp: mocks.tsaTimestamp,
    verify: mocks.tsaVerify,
  });
});

describe('testTsaAction', () => {
  it('meldet erst nach erfolgreicher Imprint- und Trust-Prüfung Erfolg', async () => {
    const result = await testTsaAction(null, customTsaForm());

    expect(mocks.createRfc3161Adapter).toHaveBeenCalledWith('https://tsa.example.test/tsr', 8_000);
    const payload = mocks.tsaTimestamp.mock.calls[0]![0] as Buffer;
    expect(mocks.tsaVerify).toHaveBeenCalledWith(payload, Buffer.from('trusted-token'));
    expect(result).toMatchObject({
      ok: true,
      error: expect.stringContaining('trust-verifiziert'),
    });
  });

  it('weist einen granted, aber untrusted oder falsch gebundenen Token zurück', async () => {
    mocks.tsaVerify.mockResolvedValue(false);

    const result = await testTsaAction(null, customTsaForm());

    expect(result).toEqual({
      ok: false,
      error:
        'Die TSA antwortet, aber der Token ist nicht an den Test-Hash oder einen konfigurierten Trust-Anchor gebunden.',
    });
  });
});
