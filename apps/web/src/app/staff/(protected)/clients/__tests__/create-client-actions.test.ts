// Fachkatalog: ACCESS-STAFF-PERMISSION-001
// Review-Befund F-01: Mandantenanlage (direkt und im Onboarding) meldet
// Validierungs-, Rechte- und Fachfehler als `{ ok: false, error }` an das
// Formular. Vorher: Redirect mit `?error=` (Eingaben verloren) bzw. Wurf in
// error.tsx. Geprüft wird der Rückkanal und dass bei einem Fehler nichts
// geschrieben wird; der Erfolgsfall leitet unverändert weiter.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  areProfessionalAssigneesEligibleTx: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/gwg/professional-review', () => ({
  areProfessionalAssigneesEligibleTx: h.areProfessionalAssigneesEligibleTx,
}));
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
  };
});

import { createClientAction } from '../new/actions';
import { createOnboardingClientAction } from '../onboarding/new/actions';

const BERUFSTRAEGER = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';

function clientForm(overrides: Record<string, string> = {}): FormData {
  const formData = new FormData();
  const values: Record<string, string> = {
    name: 'Muster GmbH',
    kind: 'JURPERS',
    datevNo: '',
    street: 'Hauptstraße 1',
    postalCode: '36304',
    city: 'Alsfeld',
    countryIso: 'DE',
    invoiceEmail: 'rechnung@muster.example',
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  formData.append('berufstraegerIds', BERUFSTRAEGER);
  return formData;
}

const actions = [
  ['createClientAction', createClientAction, '/staff/clients/'],
  ['createOnboardingClientAction', createOnboardingClientAction, '/staff/clients/onboarding/'],
] as const;

describe.each(actions)('%s — Rückkanal statt Redirect/Wurf', (_name, action, successPath) => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: { user: { id: 'staff-1' } },
    });
    h.areProfessionalAssigneesEligibleTx.mockResolvedValue(true);
  });

  it('meldet Eingabefehler mit Feldzuordnung und schreibt nichts', async () => {
    const result = await action(null, clientForm({ name: '' }));

    expect(result).toMatchObject({
      ok: false,
      error: 'Name ist Pflichtfeld',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { name: ['Name ist Pflichtfeld'] },
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  // Review-Befund F-07: Das Einzelrecht CLIENT_CREATE genügt (ADMIN/PARTNER
  // implizit); vorher warf die Action alle Nicht-Admins trotz Grant ab.
  it('verlangt das Einzelrecht CLIENT_CREATE und keine zusätzliche Admin-Rolle', async () => {
    const tx = {
      staffUser: { count: vi.fn().mockResolvedValue(1) },
      client: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'client-2' }),
      },
      clientResponsibility: { create: vi.fn() },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(action(null, clientForm())).rejects.toThrow(
      `NEXT_REDIRECT:${successPath}client-2`,
    );
    expect(h.staffActionGuard).toHaveBeenCalledWith({ requirePermission: 'CLIENT_CREATE' });
    expect(tx.client.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ allowActive: false }) }),
    );
  });

  it('gibt eine Gate-Ablehnung zurück, statt zum Login umzuleiten', async () => {
    h.staffActionGuard.mockResolvedValue({
      ok: false,
      error: 'Keine Berechtigung (CLIENT_CREATE).',
    });

    await expect(action(null, clientForm())).resolves.toEqual({
      ok: false,
      error: 'Keine Berechtigung (CLIENT_CREATE).',
    });
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('meldet eine ungültige Zuständigkeit aus der Transaktion ohne Anlage', async () => {
    const tx = {
      staffUser: { count: vi.fn().mockResolvedValue(0) },
      client: { findFirst: vi.fn(), create: vi.fn() },
      clientResponsibility: { create: vi.fn() },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(action(null, clientForm())).resolves.toEqual({
      ok: false,
      error: 'Eine gewählte Zuständigkeit ist nicht mehr aktiv oder hat keine gültige Staff-Rolle.',
    });
    expect(tx.client.create).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('legt den Mandanten an und leitet wie bisher weiter', async () => {
    const tx = {
      staffUser: { count: vi.fn().mockResolvedValue(1) },
      client: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'client-1' }),
      },
      clientResponsibility: { create: vi.fn() },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(action(null, clientForm())).rejects.toThrow(
      `NEXT_REDIRECT:${successPath}client-1`,
    );
    expect(tx.client.create).toHaveBeenCalledOnce();
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'client.created', resourceId: 'client-1' }),
    );
  });
});

describe('createClientAction — Doppel-Mandant und DATEV-Konflikt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: { user: { id: 'staff-1' } },
    });
    h.areProfessionalAssigneesEligibleTx.mockResolvedValue(true);
  });

  it('meldet den möglichen Doppel-Mandanten im Formular', async () => {
    const tx = {
      staffUser: { count: vi.fn().mockResolvedValue(1) },
      client: {
        findFirst: vi.fn().mockResolvedValue({ name: 'Muster GmbH' }),
        create: vi.fn(),
      },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    const result = await createClientAction(null, clientForm());

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Möglicher Doppel-Mandant');
    expect(tx.client.create).not.toHaveBeenCalled();
  });

  it('behält die freundliche Meldung für eine vergebene DATEV-Nummer', async () => {
    h.withTenantContext.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(createClientAction(null, clientForm({ datevNo: '12345' }))).resolves.toEqual({
      ok: false,
      error: 'DATEV-Nr. ist in dieser Kanzlei bereits vergeben.',
    });
  });
});
