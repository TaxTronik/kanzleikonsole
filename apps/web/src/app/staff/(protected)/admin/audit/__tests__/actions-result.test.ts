// Fachkatalog: AUDIT-VERIFY-ALERT-001
//
// Review-Befund F-01: Audit-Prüfung und Recovery-Checkpoint melden
// Ablehnungen als `{ ok: false, error }`, statt in error.tsx zu werfen.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNEXPECTED_ACTION_ERROR } from '@/server/actions/to-action-error';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  readTenantSettingValue: vi.fn(),
  writeTenantSettingValue: vi.fn(),
  evidenceRecord: vi.fn(),
  enqueueAuditVerify: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));
vi.mock('@taxtronik/db/tenant-settings', () => ({
  readTenantSettingValue: h.readTenantSettingValue,
  writeTenantSettingValue: h.writeTenantSettingValue,
}));
vi.mock('@taxtronik/evidence', () => ({
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY: 'audit.recovery',
  AUDIT_VERIFY_RESULT_SETTING_KEY: 'audit.verify',
}));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/jobs/audit-verify-queue', () => ({ enqueueAuditVerify: h.enqueueAuditVerify }));
vi.mock('@/server/auth/rbac', async () => {
  return {
    // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
    ...(await import('@/server/actions/to-action-error')),
  };
});
vi.mock('@/server/actions/staff-action', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  return {
    ActionError,
    staffActionGuard: h.staffActionGuard,
    // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
    staffAction: (
      await vi.importActual<typeof import('@/server/actions/action-runner')>(
        '@/server/actions/action-runner',
      )
    ).createActionRunner(h.staffActionGuard),
    withStaff: vi.fn(),
  };
});

import { createAuditRecoveryCheckpointAction, triggerAuditVerifyAction } from '../actions';

describe('Audit-Actions — Rückkanal statt Wurf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    });
    h.withTenantContext.mockImplementation(async (_ctx, fn: (tx: unknown) => unknown) => fn({}));
  });

  it.each([
    ['triggerAuditVerifyAction', triggerAuditVerifyAction],
    ['createAuditRecoveryCheckpointAction', createAuditRecoveryCheckpointAction],
  ] as const)('%s gibt die Ablehnung des Admin-Gates zurück', async (_name, action) => {
    h.staffActionGuard.mockResolvedValue({ ok: false, error: 'Nur ADMIN/PARTNER.' });

    await expect(action(null, new FormData())).resolves.toEqual({
      ok: false,
      error: 'Nur ADMIN/PARTNER.',
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.enqueueAuditVerify).not.toHaveBeenCalled();
  });

  it('meldet einen Checkpoint ohne Prüfergebnis, ohne Audit oder Neuprüfung', async () => {
    h.readTenantSettingValue.mockResolvedValue(undefined);

    await expect(createAuditRecoveryCheckpointAction(null, new FormData())).resolves.toEqual({
      ok: false,
      error: 'Noch kein Audit-Prüfergebnis vorhanden. Bitte zuerst prüfen.',
    });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.writeTenantSettingValue).not.toHaveBeenCalled();
    expect(h.enqueueAuditVerify).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('meldet eine nicht erreichbare Prüf-Queue statt einer Fehlerseite', async () => {
    h.enqueueAuditVerify.mockRejectedValue(new Error('Redis nicht erreichbar'));

    await expect(triggerAuditVerifyAction(null, new FormData())).resolves.toEqual({
      ok: false,
      error: UNEXPECTED_ACTION_ERROR,
    });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });
});
