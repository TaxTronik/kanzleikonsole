// Fachkatalog: DSGVO-REQUEST-DEADLINE-001, DSGVO-REQUEST-EVIDENCE-001
//
// Review-Befund F-01: DSGVO-Antrag erfassen, Status fortschreiben und Kontakt
// anonymisieren melden Validierungs- und Workflowfehler als `{ ok: false, error }`
// an das Formular (vorher Wurf → error.tsx bzw. stilles Abbrechen). Geprüft wird
// der Rückkanal und dass bei einem Fehler nichts geschrieben wird.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  staffActionGuard: vi.fn(),
  isStaffAdmin: vi.fn(),
  withTenantContext: vi.fn(),
  evidenceRecord: vi.fn(),
  revokeAllSessions: vi.fn(),
  anonymizeContactInTx: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenantContext }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.evidenceRecord } }));
vi.mock('@/server/auth/revocation', () => ({ revokeAllSessions: h.revokeAllSessions }));
vi.mock('@/server/dsgvo/anonymize-contact', () => ({
  anonymizeContactInTx: h.anonymizeContactInTx,
}));
vi.mock('@/server/dsgvo/export-package', () => ({ serializeDsgvoExport: vi.fn() }));
vi.mock('@/server/privacy/notice', () => ({
  readPrivacyConfigTx: vi.fn(),
  renderPrivacyNotice: vi.fn(),
}));
vi.mock('@/server/db/prisma-bytes', () => ({ prismaBytes: vi.fn() }));
vi.mock('@/server/actions/staff-action', async () => {
  const { ActionError } = await vi.importActual<typeof import('@/server/actions/action-error')>(
    '@/server/actions/action-error',
  );
  // K-02: der echte mehrphasige Ablauf (inkl. toActionError) über dem Gate-Mock.
  const { createActionRunner } = await vi.importActual<
    typeof import('@/server/actions/action-runner')
  >('@/server/actions/action-runner');
  return {
    ActionError,
    staffActionGuard: h.staffActionGuard,
    staffAction: createActionRunner(h.staffActionGuard),
  };
});

import { anonymizeContactAction, createDsgvoRequestAction, updateStatusAction } from '../actions';

const REQUEST_ID = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';
const CONTACT_ID = '8d6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e7a';

function form(values: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) formData.set(key, value);
  return formData;
}

function requestForm(overrides: Record<string, string> = {}): FormData {
  return form({
    type: 'ACCESS',
    subjectType: 'EXTERNAL',
    subjectRefId: '',
    subjectEmail: 'betroffen@example.de',
    subjectName: 'Erika Musterfrau',
    description: 'Auskunft über alle gespeicherten Daten',
    receivedAt: '2026-01-05',
    ...overrides,
  });
}

describe('DSGVO-Actions — Rückkanal statt Wurf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Gate-Mock mit der Rollenentscheidung des echten staffActionGuard
    // (requireAdmin + deniedMessage; Wahrheitstabelle: staff-action.test.ts).
    h.staffActionGuard.mockImplementation(
      async (opts: { requireAdmin?: boolean; deniedMessage?: string } = {}) =>
        opts.requireAdmin && !h.isStaffAdmin()
          ? { ok: false, error: opts.deniedMessage ?? 'Nur ADMIN/PARTNER.' }
          : {
              ok: true,
              tenantId: 'tenant-1',
              staffId: 'staff-1',
              ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
              session: { user: { id: 'staff-1' } },
            },
    );
    h.isStaffAdmin.mockReturnValue(true);
  });

  it('meldet Eingabefehler des Antrags mit Feldzuordnung und schreibt nichts', async () => {
    const result = await createDsgvoRequestAction(null, requestForm({ subjectEmail: 'kein-mail' }));

    expect(result).toMatchObject({
      ok: false,
      error: 'Validierungsfehler.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { subjectEmail: [expect.any(String)] },
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('lehnt einen Eingangstag in der Zukunft ab, ohne zu schreiben', async () => {
    await expect(
      createDsgvoRequestAction(null, requestForm({ receivedAt: '2999-01-04' })),
    ).resolves.toEqual({ ok: false, error: 'Der Eingangstag darf nicht in der Zukunft liegen.' });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('meldet die fehlende Rolle statt zu werfen', async () => {
    h.isStaffAdmin.mockReturnValue(false);

    await expect(createDsgvoRequestAction(null, requestForm())).resolves.toEqual({
      ok: false,
      error: 'Nur ADMIN/PARTNER darf DSGVO-Anträge bearbeiten.',
    });
    expect(h.staffActionGuard).toHaveBeenCalledWith({
      requireAdmin: true,
      deniedMessage: 'Nur ADMIN/PARTNER darf DSGVO-Anträge bearbeiten.',
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('meldet einen Fehler aus der Transaktion (unbekannte Referenz) ohne Redirect', async () => {
    const tx = {
      clientContact: { findUnique: vi.fn().mockResolvedValue(null) },
      dsgvoRequest: { create: vi.fn() },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(
      createDsgvoRequestAction(
        null,
        requestForm({ subjectType: 'CLIENT_CONTACT', subjectRefId: CONTACT_ID }),
      ),
    ).resolves.toEqual({ ok: false, error: 'Referenzierter Mandantenkontakt nicht gefunden.' });
    expect(tx.dsgvoRequest.create).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('legt einen gültigen Antrag an und leitet wie bisher weiter', async () => {
    const tx = { dsgvoRequest: { create: vi.fn().mockResolvedValue({ id: REQUEST_ID }) } };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(createDsgvoRequestAction(null, requestForm())).rejects.toThrow(
      `NEXT_REDIRECT:/staff/admin/dsgvo/${REQUEST_ID}`,
    );
    expect(tx.dsgvoRequest.create).toHaveBeenCalledOnce();
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'dsgvo.request.create', resourceId: REQUEST_ID }),
    );
  });

  it('meldet fehlende Abschlussnachweise und schreibt weder Status noch Audit', async () => {
    const tx = {
      dsgvoRequest: {
        findUnique: vi.fn().mockResolvedValue({
          id: REQUEST_ID,
          status: 'IN_PROGRESS',
          type: 'ERASURE',
          notes: null,
          receivedAt: new Date('2026-01-05T00:00:00.000Z'),
          resultDocumentId: null,
          resultSha256: null,
          resultReviewedAt: null,
        }),
        update: vi.fn(),
      },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    const result = await updateStatusAction(
      null,
      form({ requestId: REQUEST_ID, status: 'COMPLETED', notes: 'kurz' }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'Für den Abschluss müssen die durchgeführten Maßnahmen dokumentiert werden.',
    });
    expect(tx.dsgvoRequest.update).not.toHaveBeenCalled();
    expect(h.evidenceRecord).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it('meldet ungültige Statusdaten mit Feldzuordnung', async () => {
    const result = await updateStatusAction(
      null,
      form({ requestId: REQUEST_ID, status: 'IN_PROGRESS', resultDocumentId: 'keine-uuid' }),
    );

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { resultDocumentId: [expect.any(String)] },
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it('bestätigt einen zulässigen Statuswechsel', async () => {
    const before = {
      id: REQUEST_ID,
      status: 'RECEIVED',
      type: 'ERASURE',
      notes: null,
      receivedAt: new Date('2026-01-05T00:00:00.000Z'),
      resultDocumentId: null,
      resultSha256: null,
      resultReviewedAt: null,
    };
    const tx = {
      dsgvoRequest: {
        findUnique: vi.fn().mockResolvedValue(before),
        update: vi.fn().mockResolvedValue({
          ...before,
          status: 'IN_PROGRESS',
          responseSentAt: null,
          responseMethod: null,
          rejectionReason: null,
        }),
      },
    };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(
      updateStatusAction(null, form({ requestId: REQUEST_ID, status: 'IN_PROGRESS' })),
    ).resolves.toEqual({ ok: true });
    expect(h.evidenceRecord).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'dsgvo.request.in_progress' }),
    );
  });

  it('meldet eine ungültige Kontakt-ID beim Anonymisieren, statt still abzubrechen', async () => {
    // R-12: dieselbe Meldung, zusätzlich mit Feldzuordnung (parseFormData).
    await expect(anonymizeContactAction(null, form({ contactId: 'keine-uuid' }))).resolves.toEqual({
      ok: false,
      error: 'Ungültige Kontakt-ID.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { contactId: ['Ungültige Auswahl.'] },
    });
    expect(h.withTenantContext).not.toHaveBeenCalled();
    expect(h.revokeAllSessions).not.toHaveBeenCalled();
  });

  it('meldet einen unbekannten Kontakt beim Anonymisieren ohne Seiteneffekte', async () => {
    const tx = { clientContact: { findUnique: vi.fn().mockResolvedValue(null) } };
    h.withTenantContext.mockImplementation(async (_ctx, fn: (txArg: unknown) => unknown) => fn(tx));

    await expect(anonymizeContactAction(null, form({ contactId: CONTACT_ID }))).resolves.toEqual({
      ok: false,
      error: 'Ansprechpartner nicht gefunden.',
    });
    expect(h.revokeAllSessions).not.toHaveBeenCalled();
    expect(h.anonymizeContactInTx).not.toHaveBeenCalled();
  });
});
