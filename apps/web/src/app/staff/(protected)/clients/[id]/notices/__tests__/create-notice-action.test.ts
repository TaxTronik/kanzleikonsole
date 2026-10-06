// Fachkatalog: TAX-NOTICE-APPEAL-001, TAX-NOTICE-DATARETRIEVAL-001
//
// Review-Befund F-01: Die Plausibilitätsregeln der Bescheiderfassung kommen als
// `{ ok: false, error }` ins Formular zurück (vorher Wurf → error.tsx, Eingaben
// verloren). Die Regeln selbst bleiben unverändert; geprüft wird nur der
// Rückkanal und dass bei einem Fehler nichts geschrieben wird.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  withTenantContext: vi.fn(),
  assertClientAccessTx: vi.fn(),
  assertClientInTenant: vi.fn(),
  evidenceRecord: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/db/assert-tenant', () => ({ assertClientInTenant: h.assertClientInTenant }));
vi.mock('@/server/auth/rbac', async () => {
  return {
    assertClientAccessTx: h.assertClientAccessTx,
    isStaffAdmin: () => false,
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

import { createNoticeAction } from '../actions';

const CLIENT_ID = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';

function noticeForm(overrides: Record<string, string> = {}): FormData {
  const values: Record<string, string> = {
    clientId: CLIENT_ID,
    kind: 'EST',
    period: '2025',
    noticeDate: '2025-03-03',
    dateBasis: 'DISPATCH_DATE',
    deliveryMethod: 'POST',
    deliveryEvidenceStatus: 'CLAIMED',
    deliveryEvidenceNote: '',
    legalRemedyInstruction: 'WIRKSAM',
    legalRemedyInstructionNote: 'Belehrung vollständig geprüft',
    receivedAt: '',
    accessStatus: 'UNCONTESTED',
    accessEvidenceStatus: '',
    accessEvidenceNote: '',
    recipientName: 'Erika Musterfrau',
    recipientCountryCode: 'DE',
    recipientRegion: 'DE-HE',
    recipientLocality: '',
    recipientLocalHolidayDates: '',
    recipientHolidayContextStatus: 'STATE_LEVEL_ONLY',
    recipientBavariaAssumption: 'UNKNOWN',
    authorityName: 'Finanzamt Alsfeld-Lauterbach',
    authorityCountryCode: 'DE',
    authorityRegion: 'DE-HE',
    authorityLocality: '',
    authorityLocalHolidayDates: '',
    authorityHolidayContextStatus: 'STATE_LEVEL_ONLY',
    authorityBavariaAssumption: 'UNKNOWN',
    holidayContextNote: 'Hessischer Feiertagskalender geprüft',
    retrievalIssuedAt: '',
    retrievalNotificationDate: '',
    retrievedAt: '',
    retrievalConsentStatus: 'NOT_APPLICABLE',
    retrievalEligibility2027Status: 'NOT_APPLICABLE',
    retrievalPostalRequestStatus: 'NOT_APPLICABLE',
    retrievalPostalRequestReceivedAt: '',
    retrievalNotificationStatus: 'NOT_RECORDED',
    fileNumber: '',
    assessedAmount: '',
    expectedAmount: '',
    prepaidAmount: '',
    payAmount: '',
    reviewNotes: '',
    ...overrides,
  };
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

describe('createNoticeAction — Rückkanal statt Wurf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.staffActionGuard.mockResolvedValue({
      ok: true,
      tenantId: 'tenant-1',
      staffId: 'staff-1',
      ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
      session: { user: { id: 'staff-1' } },
    });
  });

  it.each([
    [
      'zukünftiges Ausgangsdatum',
      { noticeDate: '2999-01-04' },
      'Ausgangsdatum darf nicht in der Zukunft liegen.',
    ],
    [
      'Zugangsnachweis ohne Beschreibung',
      { accessStatus: 'LATER_RECEIPT_CLAIMED', accessEvidenceStatus: 'CLAIMED' },
      'Der Zugangsnachweis muss kurz beschrieben werden.',
    ],
    [
      'ungültiger örtlicher Feiertag',
      { recipientLocalHolidayDates: '2025-02-30' },
      'Empfängerort – örtliche Feiertage: „2025-02-30“ ist kein gültiges Datum im Format JJJJ-MM-TT.',
    ],
    [
      'bestätigter Kalender ohne Ort',
      { authorityHolidayContextStatus: 'CONFIRMED_FOR_DATE_AND_LOCATION' },
      'Behördensitz: Ort/Gemeinde ist für den bestätigten Feiertagskontext erforderlich.',
    ],
    [
      '§-122a-Angaben außerhalb des Datenabrufs',
      { retrievalConsentStatus: 'CONFIRMED' },
      '§-122a-Angaben sind nur beim Bekanntgabeweg Datenabruf zulässig.',
    ],
  ])('meldet die Plausibilitätsregel „%s" als ActionError', async (_label, overrides, error) => {
    const result = await createNoticeAction(null, noticeForm(overrides));

    expect(result).toEqual({ ok: false, error });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('liefert Schemafehler mit Feldzuordnung und schreibt nichts', async () => {
    const result = await createNoticeAction(null, noticeForm({ legalRemedyInstructionNote: 'x' }));

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { legalRemedyInstructionNote: [expect.any(String)] },
    });
    expect(result.error).toMatch(/^Validierungsfehler: /);
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('gibt die Ablehnung des Modul-/Session-Gates zurück', async () => {
    h.staffActionGuard.mockResolvedValue({ ok: false, error: 'Nicht eingeloggt.' });

    await expect(createNoticeAction(null, noticeForm())).resolves.toEqual({
      ok: false,
      error: 'Nicht eingeloggt.',
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('meldet einen Fehler in der Transaktion ohne Redirect', async () => {
    const { ActionError } = await import('@/server/actions/action-error');
    h.withTenantContext.mockImplementation(async (_ctx, fn: (tx: unknown) => unknown) => fn({}));
    h.assertClientAccessTx.mockRejectedValue(new ActionError('Kein Zugriff auf diesen Mandanten.'));

    await expect(createNoticeAction(null, noticeForm())).resolves.toEqual({
      ok: false,
      error: 'Kein Zugriff auf diesen Mandanten.',
    });
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('legt einen plausiblen Bescheid an und leitet wie bisher weiter', async () => {
    const tx = {
      taxFiling: { findUnique: vi.fn().mockResolvedValue(null) },
      taxNotice: {
        create: vi.fn(async ({ data }: { data: object }) => ({ id: 'notice-1', ...data })),
      },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));
    h.assertClientAccessTx.mockResolvedValue(undefined);
    h.assertClientInTenant.mockResolvedValue(undefined);

    await expect(createNoticeAction(null, noticeForm())).rejects.toThrow(
      `NEXT_REDIRECT:/staff/clients/${CLIENT_ID}/notices`,
    );
    expect(tx.taxNotice.create).toHaveBeenCalledOnce();
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'tax_notice.create', resourceId: 'notice-1' }),
    );
  });
});
