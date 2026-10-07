import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@/server/actions/action-error';

const mocks = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  evidenceRecord: vi.fn(),
  emitN8nEvent: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  manualCapture: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@/server/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: mocks.evidenceRecord } }));
vi.mock('@/server/gwg-onboarding/manual-capture', () => ({
  startManualGwgCaptureTx: mocks.manualCapture,
}));
vi.mock('@/server/auth/magic-link', () => ({ requestMagicLink: vi.fn() }));
vi.mock('@/server/mail/dispatch', () => ({ sendTemplateMail: vi.fn() }));
vi.mock('@/server/util/fire-and-forget', () => ({ fireAndForget: vi.fn() }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: mocks.emitN8nEvent }));
vi.mock('@/server/gwg-onboarding/service', () => ({
  generateInviteToken: vi.fn(() => ({ raw: 'raw', hash: 'hash' })),
  INVITE_TTL_DAYS: 7,
}));
vi.mock('@/server/auth/rbac', async () => ({
  // F-03: echtes Fehler-Mapping statt Nachbau (toActionError, Fehlerklassen).
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: mocks.assertClientAccessTx,
}));
vi.mock('@/server/actions/staff-action', async () => ({
  ActionError: (await import('@/server/actions/action-error')).ActionError,
  staffActionGuard: mocks.staffActionGuard,
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(mocks.staffActionGuard),
}));

import {
  onboardingAddContactAction,
  onboardingCompleteAction,
  onboardingCaptureGwgInOfficeAction,
  onboardingSendGwgAction,
  onboardingSkipAction,
} from '@/app/staff/(protected)/clients/onboarding/[id]/actions';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const CHECK_ID = '22222222-2222-4222-8222-222222222222';

function formData(): FormData {
  const data = new FormData();
  data.set('clientId', CLIENT_ID);
  return data;
}

function makeTx() {
  return {
    client: {
      findUnique: vi.fn().mockResolvedValue({
        allowActive: true,
        onboardingCompletedAt: null,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    clientContact: { count: vi.fn().mockResolvedValue(1) },
    gwgCheck: {
      findFirst: vi.fn().mockResolvedValue({
        id: CHECK_ID,
        status: 'VERIFIED',
        validUntil: new Date('2030-01-01T00:00:00.000Z'),
        verifiedAt: new Date('2026-07-15T10:00:00.000Z'),
        verifiedBy: 'professional-1',
        reviewSubmittedAt: new Date('2026-07-15T09:00:00.000Z'),
        reviewSubmittedBy: 'staff-1',
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
    session: { user: { tenantId: 'tenant-1', staffId: 'staff-1' } },
  });
  mocks.evidenceRecord.mockResolvedValue({});
  mocks.redirect.mockImplementation(() => {
    throw new Error('NEXT_REDIRECT');
  });
});

describe('Onboarding-Abschluss', () => {
  it('persistiert den Marker nur mit Kontakt und gueltiger GwG-Freigabe', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await expect(onboardingCompleteAction(null, formData())).rejects.toThrow('NEXT_REDIRECT');

    expect(mocks.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.anything(), CLIENT_ID);
    expect(tx.client.updateMany).toHaveBeenCalledWith({
      where: { id: CLIENT_ID, allowActive: true, onboardingCompletedAt: null },
      data: {
        onboardingCompletedAt: expect.any(Date),
        onboardingCompletedBy: 'staff-1',
      },
    });
    expect(mocks.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'client.onboarding.complete',
        resourceId: CLIENT_ID,
      }),
    );
  });

  it('blockiert den Abschluss ohne aktiven Ansprechpartner', async () => {
    const tx = makeTx();
    tx.clientContact.count.mockResolvedValue(0);
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    // Review-Befund F-01: der Fachfehler kommt als Ergebnis zurück, nicht als Wurf.
    await expect(onboardingCompleteAction(null, formData())).resolves.toEqual({
      ok: false,
      error: expect.stringContaining('mindestens einem aktiven Ansprechpartner'),
    });

    expect(tx.client.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('behandelt einen historischen Abschluss idempotent', async () => {
    const tx = makeTx();
    tx.client.findUnique.mockResolvedValue({
      allowActive: false,
      onboardingCompletedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await expect(onboardingCompleteAction(null, formData())).rejects.toThrow('NEXT_REDIRECT');

    expect(tx.clientContact.count).not.toHaveBeenCalled();
    expect(tx.gwgCheck.findFirst).not.toHaveBeenCalled();
    expect(tx.client.updateMany).not.toHaveBeenCalled();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });

  it('schreibt bei gleichzeitigem Doppelklick weder Marker noch Audit doppelt', async () => {
    const tx = makeTx();
    tx.client.findUnique
      .mockResolvedValueOnce({ allowActive: true, onboardingCompletedAt: null })
      .mockResolvedValueOnce({ onboardingCompletedAt: new Date('2026-07-15T10:00:00.000Z') });
    tx.client.updateMany.mockResolvedValue({ count: 0 });
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (transaction: ReturnType<typeof makeTx>) => unknown) => fn(tx),
    );

    await expect(onboardingCompleteAction(null, formData())).rejects.toThrow('NEXT_REDIRECT');

    expect(tx.client.updateMany).toHaveBeenCalledOnce();
    expect(mocks.evidenceRecord).not.toHaveBeenCalled();
  });
});

describe('GWG-SELF-ONBOARDING-001: manual collection action', () => {
  it('checks client access before switching channel and redirects to the existing GwG editor', async () => {
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (value: typeof tx) => unknown) => fn(tx),
    );
    await expect(onboardingCaptureGwgInOfficeAction(null, formData())).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(mocks.assertClientAccessTx).toHaveBeenCalledWith(tx, expect.anything(), CLIENT_ID);
    expect(mocks.manualCapture).toHaveBeenCalledWith(tx, {
      tenantId: 'tenant-1',
      clientId: CLIENT_ID,
      staffId: 'staff-1',
    });
    expect(mocks.assertClientAccessTx.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.manualCapture.mock.invocationCallOrder[0]!,
    );
    expect(mocks.redirect).toHaveBeenCalledWith(`/staff/clients/${CLIENT_ID}/gwg?from=onboarding`);
    expect(tx.client.updateMany).not.toHaveBeenCalled();
  });
  it('cannot be used without a staff session or with denied client access', async () => {
    mocks.staffActionGuard.mockResolvedValueOnce({ ok: false, error: 'unauthorized' });
    await expect(onboardingCaptureGwgInOfficeAction(null, formData())).resolves.toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(mocks.manualCapture).not.toHaveBeenCalled();
    const tx = makeTx();
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (value: typeof tx) => unknown) => fn(tx),
    );
    mocks.assertClientAccessTx.mockRejectedValueOnce(new ForbiddenError('forbidden'));
    await expect(onboardingCaptureGwgInOfficeAction(null, formData())).resolves.toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(mocks.manualCapture).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('Review-Befund F-01: Wizard-Schritte melden Fehler im Formular', () => {
  it('meldet ungültige Kontaktdaten mit Feldzuordnung und schreibt nichts', async () => {
    const data = formData();
    data.set('fullName', 'Erika Musterfrau');
    data.set('email', 'keine-mail');

    const result = await onboardingAddContactAction(null, data);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { email: [expect.any(String)] },
    });
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('meldet ungültige Einladungsdaten, ohne eine Einladung anzulegen', async () => {
    const data = formData();
    data.set('inviteName', 'E');
    data.set('inviteEmail', 'erika@example.test');

    const result = await onboardingSendGwgAction(null, data);

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { inviteName: [expect.any(String)] },
    });
    expect(mocks.withTenantContext).not.toHaveBeenCalled();
    expect(mocks.emitN8nEvent).not.toHaveBeenCalled();
  });

  it('meldet einen Fachfehler beim Einladen ohne Redirect', async () => {
    const tx = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn().mockResolvedValue([]),
      gwgOnboardingInvite: { findFirst: vi.fn().mockResolvedValue({ id: 'neu' }) },
    };
    mocks.withTenantContext.mockImplementation(
      async (_ctx: unknown, fn: (value: typeof tx) => unknown) => fn(tx),
    );
    const data = formData();
    data.set('inviteName', 'Erika Musterfrau');
    data.set('inviteEmail', 'erika@example.test');
    data.set('expectedLatestInviteId', '');

    await expect(onboardingSendGwgAction(null, data)).resolves.toEqual({
      ok: false,
      error:
        'Die Einladung wurde bereits geändert oder versendet. Bitte laden Sie den Schritt neu.',
    });
    expect(mocks.emitN8nEvent).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('meldet manipulierte Sprungziele statt zu werfen', async () => {
    const data = formData();
    data.set('next', '../gwg');

    // R-12: dieselbe Meldung, zusätzlich mit Feldzuordnung (parseFormData).
    await expect(onboardingSkipAction(null, data)).resolves.toEqual({
      ok: false,
      error: 'Ungültige Parameter.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { next: ['Ungültiges Format.'] },
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
