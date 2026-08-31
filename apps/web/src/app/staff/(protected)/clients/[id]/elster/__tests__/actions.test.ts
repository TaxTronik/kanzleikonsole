import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  guard: vi.fn(),
  context: vi.fn(),
  access: vi.fn(),
  rate: vi.fn(),
  bridge: vi.fn(),
  record: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.context }));
vi.mock('@taxtronik/elster', () => ({
  ElsterBridgeClient: class {
    kontoabfrage = m.bridge;
  },
  ElsterNotConfiguredError: class extends Error {},
  ElsterKontoabfrageInputError: class extends Error {},
  ElsterBridgeHttpError: class extends Error {},
}));
vi.mock('@/server/actions/staff-action', () => ({ staffActionGuard: m.guard }));
vi.mock('@/server/auth/rbac', () => ({ assertClientAccessTx: m.access }));
vi.mock('@/server/rate-limit', () => ({ checkRateLimit: m.rate }));
vi.mock('@/server/container', () => ({ evidenceService: { record: m.record } }));
import { kontoabfrageAction } from '../actions';
const clientId = '11111111-1111-4111-8111-111111111111';
const registrationId = '22222222-2222-4222-8222-222222222222';
function form() {
  const data = new FormData();
  Object.entries({
    clientId,
    taxRegistrationId: registrationId,
    art: 'O',
    pin: 'PRIVATE-PIN',
    testmerker: '700000004',
  }).forEach(([key, value]) => data.set(key, value));
  return data;
}
function db() {
  return {
    client: { findUnique: vi.fn().mockResolvedValue({ name: 'Client' }) },
    clientTaxRegistration: {
      findFirst: vi.fn().mockResolvedValue({ id: registrationId, numberElster: '1112034567890' }),
    },
    tenant: { findUnique: vi.fn().mockResolvedValue({ name: 'Kanzlei' }) },
    elsterKontoabfrage: { create: vi.fn().mockResolvedValue({ id: 'query', zeitraum: null }) },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.guard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant',
    staffId: 'staff',
    ctx: {},
    session: {},
  });
  m.rate.mockResolvedValue({ ok: true });
  m.bridge.mockResolvedValue({
    ok: true,
    returnCode: 0,
    nutzdatenTicket: 'ticket',
    result: {},
    errorText: null,
  });
});
describe('TAX-MASTER-DATA-001 ELSTER selection and history', () => {
  it('checks tenant/client/active ownership before dispatching a bridge query', async () => {
    const tx = db();
    tx.clientTaxRegistration.findFirst.mockResolvedValue(null);
    m.context.mockImplementation(async (_ctx, fn) => fn(tx));
    expect((await kontoabfrageAction(null, form())).ok).toBe(false);
    expect(tx.clientTaxRegistration.findFirst).toHaveBeenCalledWith({
      where: { id: registrationId, tenantId: 'tenant', clientId, archivedAt: null },
    });
    expect(m.bridge).not.toHaveBeenCalled();
    expect(tx.elsterKontoabfrage.create).not.toHaveBeenCalled();
  });
  it('persists the exact queried number even when master data changes during the round trip', async () => {
    const tx = db();
    m.context.mockImplementation(async (_ctx, fn) => fn(tx));
    m.bridge.mockImplementation(async () => {
      tx.clientTaxRegistration.findFirst.mockResolvedValue({
        id: registrationId,
        numberElster: '1113034567890',
      });
      return { ok: true, returnCode: 0, result: {}, errorText: null };
    });
    expect(await kontoabfrageAction(null, form())).toEqual({ ok: true });
    expect(m.bridge).toHaveBeenCalledWith(
      expect.objectContaining({
        abfragen: [{ art: 'O', steuernummer: '1112034567890' }],
        pin: 'PRIVATE-PIN',
      }),
    );
    expect(tx.elsterKontoabfrage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          taxRegistrationId: registrationId,
          taxNumberSnapshot: '1112034567890',
        }),
      }),
    );
    expect(JSON.stringify(tx.elsterKontoabfrage.create.mock.calls)).not.toContain('PRIVATE-PIN');
    expect(JSON.stringify(m.record.mock.calls)).not.toContain('PRIVATE-PIN');
    expect(JSON.stringify(m.record.mock.calls)).not.toContain('1112034567890');
  });
});
