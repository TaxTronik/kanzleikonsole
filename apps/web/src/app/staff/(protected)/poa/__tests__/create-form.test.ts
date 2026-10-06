// Fachkatalog: POA-LIFECYCLE-001
//
// Review-Befund R-12/K-02: createPoaAction liest das Anlageformular über
// parseFormData und läuft über staffAction. Gate (Vollmachtenmodus), die
// ADMIN/PARTNER-Prüfung vor der Eingabeprüfung, die Vorgaben fehlender
// optionaler Felder ('' wie bisher `formData.get(…) ?? ''`) und die
// Gesamtmeldung bleiben; Ablehnungen tragen zusätzlich die Feldzuordnung.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  isStaffAdmin: vi.fn(),
  preparePoaCreate: vi.fn(),
  createPoaRecord: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: vi.fn() }));
vi.mock('@/server/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/auth/rbac', async () => ({
  ...(await import('@/server/actions/to-action-error')),
  isStaffAdmin: m.isStaffAdmin,
  assertClientAccessTx: vi.fn(),
}));
vi.mock('@/server/poa/create-poa', () => ({
  preparePoaCreate: m.preparePoaCreate,
  createPoaRecord: m.createPoaRecord,
  readPoaPdfBytes: vi.fn(),
}));
vi.mock('@/server/poa/send-for-signature', () => ({ sendPoaForSignature: vi.fn() }));
vi.mock('@/server/poa/revoke-poa', () => ({ revokePoaTx: vi.fn() }));
vi.mock('@/server/actions/staff-action', async () => ({
  ActionError: (await import('@/server/actions/action-error')).ActionError,
  parseFormData: (
    await vi.importActual<typeof import('@/server/actions/form-data')>('@/server/actions/form-data')
  ).parseFormData,
  staffActionGuard: m.staffActionGuard,
  withStaff: vi.fn(),
  // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
  staffAction: (
    await vi.importActual<typeof import('@/server/actions/action-runner')>(
      '@/server/actions/action-runner',
    )
  ).createActionRunner(m.staffActionGuard),
}));

import { createPoaAction } from '../actions';

const CLIENT_ID = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

const MINIMAL: Array<[string, string]> = [
  ['clientId', CLIENT_ID],
  ['signerEmail', 'signer@example.de'],
  ['signerName', 'Sina Signer'],
  ['subject', 'Vollmacht'],
  ['validFrom', '2026-08-10'],
];

beforeEach(() => {
  vi.clearAllMocks();
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: { user: {} },
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  m.isStaffAdmin.mockReturnValue(true);
  m.preparePoaCreate.mockResolvedValue({
    ok: true,
    existingPoaId: null,
    prepared: { externMode: false, scope: 'Umfang', pdf: null },
  });
  m.createPoaRecord.mockResolvedValue('poa-1');
});

describe('createPoaAction – Anlageformular', () => {
  it('übergibt fehlende optionale Felder wie bisher als "" und leitet nach der Anlage weiter', async () => {
    await createPoaAction(null, form(MINIMAL));

    expect(m.staffActionGuard).toHaveBeenCalledWith({ modeModule: 'poa' });
    expect(m.preparePoaCreate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      {
        clientId: CLIENT_ID,
        signerContactId: '',
        signerEmail: 'signer@example.de',
        signerName: 'Sina Signer',
        subject: 'Vollmacht',
        scope: '',
        validFrom: '2026-08-10',
        validUntil: '',
        pendingDocumentId: '',
        uploadIntentId: '',
        returnContext: '',
      },
      expect.any(Function),
    );
    expect(m.revalidatePath).toHaveBeenCalledWith('/staff/poa');
    expect(m.redirect).toHaveBeenCalledWith('/staff/poa/poa-1');
  });

  it('meldet alle Formularfehler in einem Satz und ordnet sie den Feldern zu', async () => {
    const result = await createPoaAction(
      null,
      form([
        ['clientId', CLIENT_ID],
        ['signerEmail', 'keine-mail'],
        ['signerName', 'Sina Signer'],
        ['subject', 'Vollmacht'],
        ['validFrom', '2026-08-10'],
        ['validUntil', '2026-08-01'],
      ]),
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'VALIDATION_ERROR' });
    const { error, fieldErrors } = result as typeof result & {
      error: string;
      fieldErrors: Record<string, string[]>;
    };
    expect(Object.keys(fieldErrors)).toEqual(['signerEmail', 'validUntil']);
    expect(error).toBe(Object.values(fieldErrors).flat().join(', '));
    expect(error).toContain('Das Gültig-bis-Datum darf nicht vor dem Gültig-ab-Datum liegen.');
    expect(m.preparePoaCreate).not.toHaveBeenCalled();
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it('prüft ADMIN/PARTNER nach dem Gate und vor dem Formular', async () => {
    m.isStaffAdmin.mockReturnValue(false);

    const result = await createPoaAction(null, form([['signerEmail', 'keine-mail']]));

    expect(result).toEqual({
      ok: false,
      error: 'Vollmachten dürfen nur von ADMIN/PARTNER (Berufsträger) angelegt werden.',
    });
    expect(m.preparePoaCreate).not.toHaveBeenCalled();
  });

  it('gibt die Ablehnung des Gates unverändert zurück', async () => {
    m.staffActionGuard.mockResolvedValue({
      ok: false,
      error: 'Das Modul Vollmachten ist deaktiviert.',
    });

    expect(await createPoaAction(null, form(MINIMAL))).toEqual({
      ok: false,
      error: 'Das Modul Vollmachten ist deaktiviert.',
    });
    expect(m.isStaffAdmin).not.toHaveBeenCalled();
    expect(m.preparePoaCreate).not.toHaveBeenCalled();
  });
});
