// Fachkatalog: GWG-RISK-REVIEW-001, GWG-REVERIFICATION-VALIDITY-001,
// GWG-REPRESENTATIVE-AUTHORITY-001, GWG-IDENTIFICATION-EVIDENCE-001,
// GWG-BENEFICIAL-OWNERS-001
//
// Review-Befund R-12: Die GwG-Formulare lesen über parseFormData statt Feld für
// Feld. Angenommene Eingaben, Vorgaben und Gesamtmeldungen bleiben wie bei den
// bisherigen formData.get-Ketten (fehlend → null, `?? ''`, `|| undefined`,
// Haken nur bei „on“, Auswahl ohne leere Einträge, vorgelagerte JSON-Prüfung);
// Ablehnungen tragen zusätzlich errorCode und die Feldzuordnung.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
  const received: Array<[string, unknown]> = [];
  const service =
    (name: string, result?: unknown) =>
    async (_tx: unknown, data: unknown): Promise<unknown> => {
      received.push([name, data]);
      return result;
    };
  return { received, service, staffActionGuard: vi.fn(), withTenantContext: vi.fn() };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: m.withTenantContext }));
vi.mock('@/server/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/server/mail/outbox', () => ({ kickMailOutboxDelivery: vi.fn() }));
vi.mock('@/server/n8n/emit', () => ({ emitN8nEvent: vi.fn() }));
vi.mock('@/server/auth/rbac', async () => ({
  ...(await import('@/server/actions/to-action-error')),
  assertClientAccessTx: vi.fn(),
}));
vi.mock('@/server/gwg/check-cycle', () => ({
  startGwgCheckCycleTx: m.service('startCycle', { checkId: 'check-1' }),
  saveRiskAnswersTx: m.service('riskAnswers'),
}));
vi.mock('@/server/gwg/check-decisions', () => ({
  submitCheckForReviewTx: m.service('submit'),
  verifyCheckTx: m.service('verify', { sendActivationWelcome: false, validUntil: null }),
  rejectCheckTx: m.service('reject'),
}));
vi.mock('@/server/gwg/legal-entity', () => ({
  saveLegalEntityDetailsTx: m.service('legalEntity'),
}));
vi.mock('@/server/gwg/identity-document-sets', () => ({
  addIdentityDocumentSetTx: m.service('addIdentitySet', { reviewReset: false }),
  extendIdentityDocumentSetTx: m.service('extendIdentitySet'),
  newIdentityViewsFor: (data: { viewports: Array<{ documentId: string }> }, id: string) =>
    data.viewports.filter((view) => view.documentId === id),
}));
vi.mock('@/server/gwg/identity-source', () => ({
  identityViewsNeedPageCheck: () => false,
  NO_IDENTITY_PDF_PAGE_COUNTS: new Map(),
  prepareIdentityPdfPageCounts: vi.fn(),
  loadIdentitySourcesForPageCheckTx: vi.fn(),
}));
vi.mock('@/server/gwg/identity-document-confirmation', () => ({
  updateIdentityDocumentSetTx: m.service('updateIdentitySet', { verified: false }),
}));
vi.mock('@/server/gwg/identity-document-links', () => ({
  removeGwgEvidenceLinkTx: m.service('removeLink'),
  selectCurrentIdentityDocumentSetTx: m.service('selectSet'),
}));
vi.mock('@/server/gwg/evidence-documents', () => ({ findCleanGwgEvidenceDocumentsTx: vi.fn() }));
vi.mock('@/server/gwg/beneficial-owners', () => ({
  addBeneficialOwnerRoleTx: m.service('addRole'),
  removeBeneficialOwnerTx: m.service('removeOwner'),
  updateBeneficialOwnerTx: m.service('updateOwner'),
}));
vi.mock('@/server/gwg/persons', () => ({
  addGwgPersonTx: m.service('addPerson'),
  updateGwgPersonGeneralTx: m.service('updatePerson'),
}));
vi.mock('@/server/actions/staff-action', async () => {
  const { toActionError } = await import('@/server/actions/to-action-error');
  const runner = await vi.importActual<typeof import('@/server/actions/action-runner')>(
    '@/server/actions/action-runner',
  );
  return {
    ActionError: (await import('@/server/actions/action-error')).ActionError,
    parseFormData: (
      await vi.importActual<typeof import('@/server/actions/form-data')>(
        '@/server/actions/form-data',
      )
    ).parseFormData,
    staffActionGuard: m.staffActionGuard,
    withStaff: async (fn: (tx: unknown, staff: unknown) => Promise<unknown>) => {
      const guard = await m.staffActionGuard();
      if (!guard.ok) return guard;
      try {
        return { ok: true, ...(((await fn({}, guard)) as object | undefined) ?? {}) };
      } catch (error) {
        return toActionError(error);
      }
    },
    // K-02: echter mehrphasiger Ablauf über dem Gate-Mock.
    staffAction: runner.createActionRunner(m.staffActionGuard),
  };
});

import {
  saveLegalEntityDetailsAction,
  startNewCheckCycleAction,
  verifyCheckAction,
} from '../actions';
import {
  addIdDocumentAction,
  extendIdentityDocumentSetAction,
  updateIdDocumentsAction,
} from '../id-document-actions';
import { updateBeneficialOwnerAction } from '../owner-actions';

const CHECK_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const DOC_A = '33333333-3333-4333-8333-333333333333';
const DOC_B = '44444444-4444-4444-8444-444444444444';
const SET_ID = '55555555-5555-4555-8555-555555555555';

function form(entries: Array<[string, string | File]>): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

/** Abgelehnt mit der bisherigen Gesamtmeldung, zugeordnet zu genau diesen Feldern. */
function expectRejected(result: unknown, error: string, fields: string[]) {
  expect(result).toMatchObject({ ok: false, error, errorCode: 'VALIDATION_ERROR' });
  expect(Object.keys((result as { fieldErrors: object }).fieldErrors).sort()).toEqual(
    [...fields].sort(),
  );
  expect(m.received).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  m.received.length = 0;
  m.staffActionGuard.mockResolvedValue({
    ok: true,
    tenantId: 'tenant-1',
    staffId: 'staff-1',
    session: { user: {} },
    ctx: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' },
  });
  m.withTenantContext.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  );
});

describe('startNewCheckCycleAction', () => {
  it('setzt fehlenden Prüfstand und Änderungsumfang wie bisher auf "" bzw. ROUTINE', async () => {
    const result = await startNewCheckCycleAction(null, form([['clientId', CLIENT_ID]]));

    expect(result).toEqual({ ok: true, checkId: 'check-1' });
    expect(m.received).toEqual([
      ['startCycle', { clientId: CLIENT_ID, expectedLatestCheckId: '', changeScope: 'ROUTINE' }],
    ]);
  });

  it('lehnt einen leeren Änderungsumfang und eine fehlende Mandanten-ID ab', async () => {
    expectRejected(
      await startNewCheckCycleAction(null, form([['changeScope', '']])),
      'Validierungsfehler.',
      ['clientId', 'changeScope'],
    );
  });
});

describe('saveLegalEntityDetailsAction', () => {
  const fields: Array<[string, string]> = [
    ['checkId', CHECK_ID],
    ['clientId', CLIENT_ID],
    ['legalForm', 'GmbH'],
    ['ownershipStructureNotes', 'Erika Muster hält alle Anteile.'],
    ['expectedRevision', 'rev-1'],
  ];

  it('meldet eine fehlende oder unlesbare Vertreterliste vor allen übrigen Angaben', async () => {
    expectRejected(
      await saveLegalEntityDetailsAction(null, form([['legalForm', '']])),
      'Gesetzliche Vertreter müssen über erfasste Personen ausgewählt werden.',
      ['representativesJson'],
    );
    expectRejected(
      await saveLegalEntityDetailsAction(null, form([['representativesJson', '{']])),
      'Die Vertreterliste ist ungültig.',
      ['representativesJson'],
    );
  });

  it('übernimmt fehlende Registerangaben als "" und den Haken nur bei „on“', async () => {
    const representatives = [{ fullName: 'Erika Muster' }];
    const withEntry = form([
      ...fields,
      ['representativesJson', JSON.stringify(representatives)],
      ['noRegisterEntry', 'on'],
    ]);

    expect(await saveLegalEntityDetailsAction(null, withEntry)).toEqual({ ok: true });
    expect(m.received).toEqual([
      [
        'legalEntity',
        {
          checkId: CHECK_ID,
          clientId: CLIENT_ID,
          legalForm: 'GmbH',
          registerNumber: '',
          registerAuthority: '',
          noRegisterEntry: true,
          representatives,
          ownershipStructureNotes: 'Erika Muster hält alle Anteile.',
          expectedRevision: 'rev-1',
        },
      ],
    ]);

    m.received.length = 0;
    expectRejected(
      await saveLegalEntityDetailsAction(
        null,
        form([
          ...fields,
          ['representativesJson', JSON.stringify(representatives)],
          ['noRegisterEntry', 'yes'],
        ]),
      ),
      'Registernummer erforderlich. Register/Registergericht erforderlich.',
      ['registerNumber', 'registerAuthority'],
    );
  });
});

describe('verifyCheckAction', () => {
  it('weist eine ältere Snapshot-Fassung vor der fehlenden Bestätigung zum Neuladen zurück', async () => {
    const result = await verifyCheckAction(
      null,
      form([
        ['checkId', CHECK_ID],
        ['clientId', CLIENT_ID],
        ['reviewSnapshotVersion', '1'],
      ]),
    );

    expect(result).toEqual({
      ok: false,
      error:
        'Der Prüfsnapshot verwendet eine ältere Fassung. Bitte Seite neu laden und alle Angaben erneut prüfen.',
    });
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });

  it('meldet bei aktueller Fassung die fehlende Berufsträger-Bestätigung', async () => {
    const result = await verifyCheckAction(
      null,
      form([
        ['checkId', CHECK_ID],
        ['clientId', CLIENT_ID],
        ['reviewSnapshotVersion', '2'],
        ['reviewSnapshotHash', 'a'.repeat(64)],
      ]),
    );

    expect(result).toEqual({
      ok: false,
      error:
        'Die ausdrückliche Berufsträger-Bestätigung des vollständig angezeigten Prüfsnapshots fehlt.',
    });
    expect(m.withTenantContext).not.toHaveBeenCalled();
  });
});

describe('addIdDocumentAction', () => {
  const register: Array<[string, string]> = [
    ['checkId', CHECK_ID],
    ['clientId', CLIENT_ID],
    ['type', 'HANDELSREGISTERAUSZUG'],
  ];

  it('übernimmt fehlende Angaben wie bisher und greift ohne Auswahl auf documentId zurück', async () => {
    const result = await addIdDocumentAction(
      null,
      form([...register, ['documentIds', ''], ['documentId', DOC_A]]),
    );

    expect(result).toEqual({ ok: true, reviewReset: false });
    expect(m.received).toEqual([
      [
        'addIdentitySet',
        {
          checkId: CHECK_ID,
          clientId: CLIENT_ID,
          type: 'HANDELSREGISTERAUSZUG',
          subjectKey: '',
          number: '',
          issuedBy: '',
          issueDate: '',
          expiryDate: '',
          replacementMode: 'none',
          replaceDocumentSetId: '',
          viewports: [],
          documentIds: [DOC_A],
        },
      ],
    ]);
  });

  it('meldet einen unlesbaren Ausweisausschnitt vor allen übrigen Angaben', async () => {
    expectRejected(
      await addIdDocumentAction(
        null,
        form([
          ['type', 'X'],
          ['viewports', '{'],
        ]),
      ),
      'Ungültiger Ausweisausschnitt.',
      ['viewports'],
    );
  });

  it('prüft die Auswahl ohne leere Einträge (höchstens zwei, keine Dubletten)', async () => {
    expectRejected(
      await addIdDocumentAction(
        null,
        form([
          ['checkId', CHECK_ID],
          ['clientId', CLIENT_ID],
          ['type', 'PERSONALAUSWEIS'],
          ['subjectKey', `representative:${DOC_B}`],
          ['documentIds', DOC_A],
          ['documentIds', ''],
          ['documentIds', DOC_A],
        ]),
      ),
      'Jeder Aktenbeleg darf im Satz nur einmal vorkommen.',
      ['documentIds'],
    );
  });
});

describe('extendIdentityDocumentSetAction', () => {
  it('ignoriert leere Einträge der Auswahl', async () => {
    const result = await extendIdentityDocumentSetAction(
      null,
      form([
        ['checkId', CHECK_ID],
        ['clientId', CLIENT_ID],
        ['targetDocumentSetId', SET_ID],
        ['documentIds', ''],
        ['documentIds', DOC_A],
      ]),
    );

    expect(result).toEqual({ ok: true });
    expect(m.received).toEqual([
      [
        'extendIdentitySet',
        {
          checkId: CHECK_ID,
          clientId: CLIENT_ID,
          targetDocumentSetId: SET_ID,
          documentIds: [DOC_A],
        },
      ],
    ]);
  });

  it('verlangt mindestens eine Datei', async () => {
    expectRejected(
      await extendIdentityDocumentSetAction(
        null,
        form([
          ['checkId', CHECK_ID],
          ['clientId', CLIENT_ID],
          ['targetDocumentSetId', SET_ID],
        ]),
      ),
      'Mindestens eine Datei ist erforderlich.',
      ['documentIds'],
    );
  });
});

describe('updateIdDocumentsAction', () => {
  const identity: Array<[string, string]> = [
    ['checkId', CHECK_ID],
    ['clientId', CLIENT_ID],
    ['documentSetId', SET_ID],
    ['type', 'PERSONALAUSWEIS'],
    ['subjectKey', `representative:${DOC_B}`],
    ['number', 'L01X00T47'],
    ['issuedBy', 'Stadt Berlin'],
    ['issueDate', '2025-01-01'],
    ['expiryDate', '2099-01-01'],
    ['expectedRevision', 'rev-1'],
  ];

  it('speichert ohne Absicht wie bisher als "save"', async () => {
    expect(await updateIdDocumentsAction(null, form(identity))).toEqual({
      ok: true,
      verified: false,
    });
    expect(m.received).toEqual([
      [
        'updateIdentitySet',
        expect.objectContaining({ intent: 'save', documentSetId: SET_ID, number: 'L01X00T47' }),
      ],
    ]);
  });

  it('lehnt ein fehlendes Ausstellungsdatum als Datumsfehler ab', async () => {
    const result = await updateIdDocumentsAction(
      null,
      form(identity.filter(([name]) => name !== 'issueDate')),
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'VALIDATION_ERROR' });
    expect(Object.keys((result as { fieldErrors: object }).fieldErrors)).toEqual(['issueDate']);
    expect(m.received).toEqual([]);
  });
});

describe('updateBeneficialOwnerAction', () => {
  const owner: Array<[string, string]> = [
    ['ownerId', DOC_B],
    ['checkId', CHECK_ID],
    ['clientId', CLIENT_ID],
    ['fullName', 'Erika Muster'],
    ['birthDate', '1980-01-02'],
    ['birthPlace', 'Berlin'],
    ['residence', 'Musterstraße 1, 10115 Berlin'],
    ['nationality', 'deutsch'],
    ['isPep', 'false'],
    ['expectedRevision', 'rev-1'],
  ];

  it('lässt einen leeren Anteil wie bisher weg', async () => {
    expect(await updateBeneficialOwnerAction(null, form([...owner, ['ownershipPct', '']]))).toEqual(
      { ok: true },
    );
    expect(m.received).toEqual([
      [
        'updateOwner',
        {
          ownerId: DOC_B,
          checkId: CHECK_ID,
          clientId: CLIENT_ID,
          fullName: 'Erika Muster',
          birthDate: '1980-01-02',
          birthPlace: 'Berlin',
          residence: 'Musterstraße 1, 10115 Berlin',
          nationality: 'deutsch',
          ownershipPct: undefined,
          isPep: false,
          expectedRevision: 'rev-1',
        },
      ],
    ]);
  });

  it('lehnt fehlende Pflichtangaben mit der bisherigen Meldung ab', async () => {
    expectRejected(
      await updateBeneficialOwnerAction(
        null,
        form(owner.filter(([name]) => name !== 'birthPlace' && name !== 'residence')),
      ),
      'Ungültige Angaben zur Person.',
      ['birthPlace', 'residence'],
    );
  });
});
