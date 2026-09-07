import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  staff: vi.fn(),
  context: vi.fn(),
  client: vi.fn(),
  check: vi.fn(),
  history: vi.fn(),
  invites: vi.fn(),
  contacts: vi.fn(),
  assignment: vi.fn(),
  documents: vi.fn(),
  uploads: vi.fn(),
}));
vi.mock('@/server/auth/staff-page', () => ({ requireStaffPage: mocks.staff }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: mocks.context }));
vi.mock('@/server/gwg/evidence-documents', () => ({
  findCleanGwgEvidenceDocumentsTx: mocks.documents,
}));
// Separate async RSC; its own authorisation and mandate queries are outside this page test.
vi.mock('@/server/mandate-expansion/gwg-structure-panel', () => ({
  GwgStructurePanel: () => null,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  notFound: () => {
    throw Error('not-found');
  },
}));
vi.mock('../actions', () => ({
  openCheckAction: vi.fn(),
  startNewCheckCycleAction: vi.fn(),
  saveRiskAnswersAction: vi.fn(),
  saveLegalEntityDetailsAction: vi.fn(),
  submitCheckForReviewAction: vi.fn(),
  verifyCheckAction: vi.fn(),
  rejectCheckAction: vi.fn(),
}));
vi.mock('../owner-actions', () => ({
  addGwgPersonAction: vi.fn(),
  updateGwgPersonGeneralAction: vi.fn(),
  addBeneficialOwnerRoleAction: vi.fn(),
  addBeneficialOwnerAction: vi.fn(),
  updateBeneficialOwnerAction: vi.fn(),
  removeBeneficialOwnerAction: vi.fn(),
}));
vi.mock('../id-document-actions', () => ({
  searchUnlinkedGwgDocumentsAction: vi.fn(),
  addIdDocumentAction: vi.fn(),
  extendIdentityDocumentSetAction: vi.fn(),
  updateIdDocumentsAction: vi.fn(),
  removeGwgEvidenceLinkAction: vi.fn(),
  selectCurrentIdentityDocumentSetAction: vi.fn(),
}));
vi.mock('../invite-actions', () => ({ sendInviteAction: vi.fn(), cancelInviteAction: vi.fn() }));

import GwgPage from '../page';
import { loadGwgPageData } from '../gwg-page-data';
import { buildGwgPageModel } from '../gwg-page-model';
import { gwgIdentityDocumentSetRevision } from '@/server/gwg/revisions';
import { gwgProfessionalReviewSnapshotHash } from '@/server/gwg/review-snapshot';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const staffId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-09-07T10:00:00.000Z');
function evidence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evidence-1',
    gwgCheckId: '44444444-4444-4444-8444-444444444444',
    documentSetId: 'set-1',
    documentId: 'file-1',
    type: 'PERSONALAUSWEIS',
    ownerName: 'Testmandant',
    number: 'DOC123',
    issuedBy: 'Testbehörde',
    issueDate: null,
    expiryDate: new Date('2027-09-07T00:00:00Z'),
    verifiedAt: now,
    naturalClientSubjectId: clientId,
    beneficialOwnerSubjectId: null,
    representativeSubjectId: null,
    identityAssignmentConfirmedAt: now,
    identityAssignmentConfirmedBy: staffId,
    notes: null,
    viewports: null,
    document: {
      id: 'file-1',
      tenantId,
      clientId,
      title: 'Synthetischer Ausweis',
      createdAt: now,
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
      gwgDestructionRequestedAt: null,
      gwgDestroyedAt: null,
      versions: [{ scanStatus: 'CLEAN', scanCompletedAt: now }],
    },
    ...overrides,
  };
}
function owner() {
  return {
    id: 'owner-1',
    fullName: 'Doppelrolle',
    birthDate: new Date('1990-01-01T00:00:00Z'),
    birthPlace: null,
    nationality: 'DE',
    residence: null,
    isPep: false,
    ownershipPct: '75',
    notes: null,
  };
}
function representative() {
  return { ...owner(), id: 'representative-1', position: 0, linkedBeneficialOwnerId: 'owner-1' };
}
function check(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenantId,
    clientId,
    status: 'VERIFIED',
    changeScope: 'INITIAL',
    createdAt: now,
    validUntil: new Date('2027-09-07T10:00:00Z'),
    destroyedAt: null,
    verifiedAt: now,
    verifiedBy: staffId,
    reviewSubmittedAt: now,
    reviewSubmittedBy: staffId,
    riskLevel: 'LOW',
    riskScore: 0,
    riskAnswers: {},
    riskBreakdown: null,
    notes: null,
    rejectedReason: null,
    legalForm: 'GmbH',
    registerNumber: null,
    registerAuthority: null,
    noRegisterEntry: false,
    representativeNames: [],
    representatives: [],
    beneficialOwners: [],
    idDocuments: [],
    ownershipStructureNotes: null,
    ...overrides,
  };
}
async function renderPage(value = check()) {
  mocks.check.mockResolvedValue(value);
  return renderToStaticMarkup(
    await GwgPage({
      params: Promise.resolve({ id: clientId }),
      searchParams: Promise.resolve({ from: 'onboarding' }),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.staff.mockResolvedValue({ user: { tenantId, staffId, roles: ['ADMIN'] } });
  mocks.client.mockResolvedValue({
    id: clientId,
    tenantId,
    name: 'Testmandant',
    kind: 'NATPERS',
    street: null,
    postalCode: null,
    city: null,
    countryIso: 'DE',
  });
  mocks.history.mockResolvedValue([]);
  mocks.invites.mockResolvedValue([]);
  mocks.contacts.mockResolvedValue([]);
  mocks.documents.mockResolvedValue([]);
  mocks.uploads.mockResolvedValue([]);
  mocks.assignment.mockResolvedValue({ id: 'assignment' });
  mocks.context.mockImplementation(async (_context, run) =>
    run({
      client: { findUnique: mocks.client },
      gwgCheck: { findFirst: mocks.check, findMany: mocks.history },
      gwgOnboardingInvite: { findMany: mocks.invites },
      clientContact: { findMany: mocks.contacts },
      clientResponsibility: { findFirst: mocks.assignment },
      document: { findMany: mocks.uploads },
    }),
  );
});
afterEach(() => vi.useRealTimers());

describe('GWG-REVERIFICATION-VALIDITY-001 / GWG-RETENTION-DESTRUCTION-001: current page validity', () => {
  it('offers the onboarding continuation for a still valid verified check', async () => {
    const html = await renderPage();
    expect(html).toContain('Mandant ist verifiziert.');
    expect(html).toContain(`/staff/clients/onboarding/${clientId}?step=poa`);
  });
  it.each([new Date(now.getTime() - 1), now])(
    'does not show a verified check past its validity instant as released (%s)',
    async (validUntil) => {
      const html = await renderPage(check({ validUntil }));
      expect(html).not.toContain('Mandant ist verifiziert.');
      expect(html).not.toContain('?step=poa');
      expect(html).toContain('Prüfung ist abgelaufen.');
      expect(html).toContain('<span class="badge badge-red">Abgelaufen/ersetzt</span>');
    },
  );
  it.each(['VERIFIED', 'DRAFT', 'IN_REVIEW'])(
    'renders a destroyed %s skeleton without persons, evidence or decision controls',
    async (status) => {
      const html = await renderPage(check({ status, destroyedAt: now }));
      expect(html).not.toContain('Mandant ist verifiziert.');
      expect(html).not.toContain('?step=poa');
      expect(html).toContain('Prüfaufzeichnung wurde vernichtet.');
      expect(html).not.toContain('Allgemeine Angaben');
      expect(html).not.toContain('Ausweis fehlt');
      expect(html).not.toContain('gwg-risk-');
      expect(html).not.toContain('name="reviewSnapshotHash"');
      expect(html).not.toContain('Verifizieren und Mandant aktivieren');
      expect(html).not.toContain('Berufsträger-Prüfmodus');
    },
  );
});

describe('GWG-RISK-REVIEW-001 / GWG-SELF-ONBOARDING-001: page workflow and review authority', () => {
  it('keeps history, master data, invitation, persons, evidence and risk in workflow order', async () => {
    mocks.client.mockResolvedValue({ id: clientId, tenantId, name: 'Test GmbH', kind: 'JURPERS' });
    mocks.history.mockResolvedValue([check()]);
    const html = await renderPage(
      check({
        status: 'DRAFT',
        reviewSubmittedAt: null,
        representatives: [representative()],
        beneficialOwners: [owner()],
      }),
    );
    const markers = [
      'Prüfverlauf (1)',
      'Stammdaten und gesetzliche Vertretung',
      '<ol class="stepper">',
      'Einladung an den Mandanten',
      '>Personen<',
      'Neue Person erfassen',
      '>Allgemeine Angaben<',
      '>Zugeordnete Rollen<',
      'Rechtsträger- und Registernachweise',
      '>Risikobewertung<',
    ];
    const positions = markers.map((marker) =>
      html.indexOf(
        marker,
        marker === '>Risikobewertung<' ? html.indexOf('Rechtsträger- und Registernachweise') : 0,
      ),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(html).toContain('1 Person');
    expect(html.match(/Nachweis hinzufügen/g)).toHaveLength(5);
    const registerSummary = html
      .match(/<details\b[^>]*><summary>[\s\S]*?<\/summary>/g)
      ?.find((summary) => summary.includes('Handelsregisterauszug'));
    expect(registerSummary).toBeDefined();
    expect(registerSummary).not.toMatch(/<details[^>]*\bopen=/);
  });
  it('binds professional confirmation to the unchanged persisted snapshot', async () => {
    const value = check({ status: 'IN_REVIEW' });
    const html = await renderPage(value);
    expect(html).toContain('Berufsträger-Prüfmodus');
    expect(html).toContain('Verifizieren und Mandant aktivieren');
    const data = await loadGwgPageData({ tenantId, clientId, staffId });
    const hash = gwgProfessionalReviewSnapshotHash({ ...data!.check!, client: data!.client });
    expect(html).toContain(`name="reviewSnapshotHash" value="${hash}"`);
    expect(mocks.assignment).toHaveBeenCalledWith({
      where: {
        tenantId,
        clientId,
        staffId,
        role: 'BERUFSTRAEGER',
        staff: { tenantId, active: true, isProfessional: true, roles: { some: {} } },
      },
      select: { id: true },
    });
    expect(mocks.context).toHaveBeenCalledWith(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      expect.any(Function),
    );
  });
  it('does not offer final approval to an ADMIN without the fresh professional assignment', async () => {
    mocks.assignment.mockResolvedValue(null);
    const html = await renderPage(check({ status: 'IN_REVIEW' }));
    expect(html).not.toContain('Berufsträger-Prüfmodus');
    expect(html).not.toContain('Verifizieren und Mandant aktivieren');
    expect(html).not.toContain('name="reviewSnapshotHash"');
  });
  it('does not load any tenant data before the staff guard succeeds', async () => {
    mocks.staff.mockRejectedValue(new Error('unauthenticated'));
    await expect(renderPage()).rejects.toThrow('unauthenticated');
    expect(mocks.context).not.toHaveBeenCalled();
  });
  it('stops loading when the client does not exist', async () => {
    mocks.client.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow('not-found');
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it('shows the last invitation without reading unused uploaded documents', async () => {
    mocks.invites.mockResolvedValue([
      {
        id: 'invite-1',
        status: 'SUBMITTED',
        inviteName: 'Testkontakt',
        inviteEmail: 'test@example.test',
        createdAt: now,
        expiresAt: now,
        submittedAt: now,
        uploadedDocumentIds: ['never-load'],
      },
    ]);
    const html = await renderPage();
    expect(html).toContain('Testkontakt');
    expect(html).toContain('test@example.test');
    expect(mocks.uploads).not.toHaveBeenCalled();
  });
});

describe('GWG-IDENTIFICATION-EVIDENCE-001 / GWG-BENEFICIAL-OWNERS-001 / GWG-REPRESENTATIVE-AUTHORITY-001: evidence projection', () => {
  it('shows linked owner evidence under the single representative/owner person and preserves raw CAS revisions', async () => {
    mocks.client.mockResolvedValue({ id: clientId, tenantId, name: 'Test GmbH', kind: 'JURPERS' });
    const doc = evidence({
      naturalClientSubjectId: null,
      beneficialOwnerSubjectId: 'owner-1',
      ownerName: 'Doppelrolle',
      viewports: { legacyField: true },
    });
    const html = await renderPage(
      check({
        representatives: [representative()],
        beneficialOwners: [owner()],
        idDocuments: [doc],
      }),
    );
    expect(html).toContain('1 Person');
    expect(html).toContain('WB 75 %');
    expect(html).toContain('DOC123');
    expect(html).not.toContain('Nicht zugeordnete Nachweise');
    const data = await loadGwgPageData({ tenantId, clientId, staffId });
    const model = buildGwgPageModel(data!, now);
    expect(model.persons).toHaveLength(1);
    expect(model.persons[0]!.groups).toHaveLength(1);
    expect(model.persons[0]!.groups[0]!.revision).toBe(gwgIdentityDocumentSetRevision([doc]));
  });
  it('keeps superseded sets out of current identity status and renders them as history', async () => {
    const html = await renderPage(
      check({
        idDocuments: [
          evidence(),
          evidence({ id: 'old-evidence', documentSetId: 'old-set', supersededAt: now }),
        ],
      }),
    );
    expect(html).toContain('Ausweis bestätigt');
    expect(html).not.toContain('Mehrere aktive Ausweise');
    expect(html).toContain('Alte Ausweise (1)');
  });
  it.each([
    { tenantId: 'other-tenant' },
    { clientId: 'other-client' },
    { classification: 'CLIENT_DOCUMENT' },
    { deletedAt: now },
    { gwgDestructionRequestedAt: now },
    { gwgDestroyedAt: now },
    { versions: [] },
    { versions: [{ scanStatus: 'PENDING', scanCompletedAt: null }] },
    { versions: [{ scanStatus: 'CLEAN', scanCompletedAt: null }] },
  ])('does not expose an unavailable file in the rendered evidence (%j)', async (unavailable) => {
    const doc = evidence();
    const html = await renderPage(
      check({ idDocuments: [{ ...doc, document: { ...doc.document, ...unavailable } }] }),
    );
    expect(html).not.toContain('Synthetischer Ausweis');
    expect(html).not.toContain('/api/documents/file-1');
    expect(html).toContain('DOC123');
  });
  it('does not render retained person/document details for a destroyed legal-entity check', async () => {
    mocks.client.mockResolvedValue({ id: clientId, tenantId, name: 'Test GmbH', kind: 'JURPERS' });
    const html = await renderPage(
      check({
        destroyedAt: now,
        representatives: [representative()],
        beneficialOwners: [owner()],
        idDocuments: [evidence()],
      }),
    );
    expect(html).not.toContain('Doppelrolle');
    expect(html).not.toContain('Synthetischer Ausweis');
    expect(html).not.toContain('Stammdaten bearbeiten');
    expect(html).not.toContain('Nachweis hinzufügen');
    expect(html).toContain('Änderung erfassen und Prüfung neu starten');
  });
});
