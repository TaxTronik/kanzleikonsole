// @vitest-environment jsdom
// Lokaler GwG-Bearbeitungszustand als Verhaltenstest in jsdom (B-08, Welle 15)
// statt Quelltextprüfung. Der Dateiname bleibt, weil die Regeln ihn als
// test_ref führen; daher createElement statt JSX. Den Wechsel auf IN_REVIEW
// nach der Einreichung und die Glocken-Aktualisierung nach einer Entscheidung
// prüft decision-forms.test.tsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement as el, type ComponentType, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentitySubjectOption } from '@/server/gwg/identity-subject';

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateIdDocuments: vi.fn(),
  saveLegalEntityDetails: vi.fn(),
  addGwgPerson: vi.fn(),
  updatePersonGeneral: vi.fn(),
  addOwnerRole: vi.fn(),
  updateOwner: vi.fn(),
  removeOwner: vi.fn(),
  confirmMessages: [] as string[],
}));

// Stabiles Router-Objekt wie in Next (Effekte hängen von seiner Identität ab).
const router = { refresh: h.refresh };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../id-document-actions', () => ({
  updateIdDocumentsAction: h.updateIdDocuments,
  extendIdentityDocumentSetAction: vi.fn(),
  selectCurrentIdentityDocumentSetAction: vi.fn(),
  removeGwgEvidenceLinkAction: vi.fn(),
  addIdDocumentAction: vi.fn(),
  searchUnlinkedGwgDocumentsAction: vi.fn(async () => ({ ok: true, documents: [] })),
}));
vi.mock('../actions', () => ({ saveLegalEntityDetailsAction: h.saveLegalEntityDetails }));
vi.mock('../owner-actions', () => ({
  addGwgPersonAction: h.addGwgPerson,
  updateGwgPersonGeneralAction: h.updatePersonGeneral,
  addBeneficialOwnerRoleAction: h.addOwnerRole,
  updateBeneficialOwnerAction: h.updateOwner,
  removeBeneficialOwnerAction: h.removeOwner,
}));
vi.mock('../add-id-doc-form', () => ({ AddIdDocumentForm: () => null }));
vi.mock('@/components/document-preview', () => ({ DocumentPreviewButton: () => null }));
vi.mock('@/components/document-upload-button', () => ({ DocumentUploadButton: () => null }));
vi.mock('@/components/gwg/saved-identity-views', () => ({ SavedIdentityViews: () => null }));
vi.mock('@/components/ui/modal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/modal')>()),
  confirmFormSubmission: (_event: unknown, message: string) => {
    h.confirmMessages.push(message);
  },
}));

import { IdentityDocumentReview, type IdentityReviewGroup } from '../identity-document-review';
import { GwgEditStateProvider, GwgLiveStatusBadge, useGwgEditState } from '../edit-state-context';
import { GwgIdentitySubjectsProvider, useGwgIdentitySubjects } from '../identity-subjects-context';
import { LegalEntityDetailsForm } from '../legal-entity-details-form';
import { PersonRolesPanel } from '../person-roles-panel';
import { NewGwgPersonForm } from '../new-gwg-person-form';
import { BeneficialOwnerForm } from '../beneficial-owner-form';
import { PersonGeneralForm } from '../person-general-form';

/** createElement für Provider mit Pflicht-children (Kinder als Restargumente). */
function provider<P extends object>(
  type: ComponentType<P & { children: ReactNode }>,
  props: P,
  ...children: ReactNode[]
) {
  return el(type as ComponentType<P>, props, ...children);
}

const CHECK_ID = 'check-1';
const CLIENT_ID = 'client-1';
const SUBJECT = {
  key: 'NATURAL_CLIENT:client-1',
  id: 'client-1',
  kind: 'NATURAL_CLIENT',
  name: 'Max Muster',
  roles: ['MANDANT'],
} as IdentitySubjectOption;

const IDENTITY_FIELDS = {
  type: 'PERSONALAUSWEIS' as const,
  issuedBy: 'Stadt Alsfeld',
  issueDate: '2021-01-15',
  expiryDate: '2031-01-14',
  subjectKey: SUBJECT.key,
  ownerName: 'Max Muster',
};

function identityGroup(revision = 'rev-1'): IdentityReviewGroup {
  return {
    key: 'set:set-1',
    documentSetId: 'set-1',
    subjectKey: SUBJECT.key,
    revision,
    documents: [
      {
        id: 'doc-1',
        gwgCheckId: CHECK_ID,
        documentSetId: 'set-1',
        documentId: 'file-1',
        type: 'PERSONALAUSWEIS',
        ownerName: 'Max Muster',
        number: 'L01X00T47',
        issuedBy: 'Stadt Alsfeld',
        issueDate: '2021-01-15',
        expiryDate: '2031-01-14',
        verifiedAt: null,
        naturalClientSubjectId: 'client-1',
        beneficialOwnerSubjectId: null,
        representativeSubjectId: null,
        identityAssignmentConfirmedAt: null,
        identityAssignmentConfirmedBy: null,
        notes: null,
        viewports: [],
        document: { id: 'file-1', title: 'Ausweis.pdf', createdAt: '2026-10-01T08:00:00Z' },
      },
    ],
  };
}

/** Testhebel für Personenmutationen, die Ausweissätze entbestätigen. */
function InvalidateIdentity() {
  const { registerIdentityInvalidations } = useGwgIdentitySubjects();
  return el(
    'button',
    {
      type: 'button',
      onClick: () =>
        registerIdentityInvalidations([{ documentSetId: 'set-1', revision: 'rev-invalidated' }]),
    },
    'Person ändern',
  );
}

function renderIdentity(group = identityGroup()) {
  const tree = (current: IdentityReviewGroup) =>
    provider(
      GwgEditStateProvider,
      { initialStatus: 'IN_REVIEW' as const },
      el(GwgLiveStatusBadge),
      provider(
        GwgIdentitySubjectsProvider,
        { initialOptions: [SUBJECT] },
        el(InvalidateIdentity),
        el(IdentityDocumentReview, {
          checkId: CHECK_ID,
          clientId: CLIENT_ID,
          groups: [current],
          subjectOptions: [SUBJECT],
          clientDocuments: [],
          grandfathered: false,
          disabled: false,
        }),
      ),
    );
  const view = render(tree(group));
  return { ...view, rerenderGroup: (next: IdentityReviewGroup) => view.rerender(tree(next)) };
}

function identityCard(): HTMLDetailsElement {
  return document.querySelector('details.group') as HTMLDetailsElement;
}

async function saveIdentity(number: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
  fireEvent.change(screen.getByLabelText('Ausweisnummer'), { target: { value: number } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Angaben speichern' }));
  });
}

function submitted(mock: typeof h.updateIdDocuments, call: number) {
  return Object.fromEntries(mock.mock.calls[call]![1] as FormData);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.confirmMessages.length = 0;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('lokaler GwG-Bearbeitungszustand', () => {
  it('behält die Ausweisprüfung nach dem Speichern aufgeklappt und setzt die Revision lokal fort', async () => {
    h.updateIdDocuments
      .mockResolvedValueOnce({
        ok: true,
        revision: 'rev-2',
        saved: { ...IDENTITY_FIELDS, number: 'NEU00001' },
      })
      .mockResolvedValueOnce({
        ok: true,
        revision: 'rev-3',
        reviewReset: true,
        saved: { ...IDENTITY_FIELDS, number: 'NEU00002' },
      });
    const { rerenderGroup } = renderIdentity();
    expect(identityCard().open).toBe(false);

    await saveIdentity('NEU00001');
    expect(submitted(h.updateIdDocuments, 0)).toMatchObject({
      intent: 'save',
      expectedRevision: 'rev-1',
      number: 'NEU00001',
    });
    await waitFor(() =>
      expect(screen.getByText('Ausweisnummer').nextElementSibling!.textContent).toBe('NEU00001'),
    );
    expect(identityCard().open).toBe(true);
    expect(h.refresh).toHaveBeenCalled();

    // Ein RSC-Refresh mit veraltetem Serverstand (alte Revision) ersetzt die
    // Karte nicht und dreht die lokale Nachfolger-Revision nicht zurück.
    rerenderGroup({ ...identityGroup('rev-1') });
    expect(identityCard().open).toBe(true);
    // Der nachgezogene Serverstand (neue Revision, neue Prüfzeitpunkte) hält
    // die Karte gemountet; sie bleibt aufgeklappt.
    const caughtUp = identityGroup('rev-2');
    caughtUp.documents[0]!.number = 'NEU00001';
    caughtUp.documents[0]!.verifiedAt = '2026-10-12T09:00:00.000Z';
    rerenderGroup(caughtUp);
    expect(identityCard().open).toBe(true);
    await saveIdentity('NEU00002');
    expect(submitted(h.updateIdDocuments, 1)).toMatchObject({ expectedRevision: 'rev-2' });
    // reviewReset aus der Action setzt den Kopfstatus lokal auf Entwurf.
    await waitFor(() => expect(screen.getByText('Entwurf')).toBeTruthy());
  });

  it('übernimmt eine Entbestätigung durch Personenänderung und quittiert sie mit dem nächsten Speichern', async () => {
    h.updateIdDocuments.mockResolvedValueOnce({
      ok: true,
      verified: true,
      revision: 'rev-4',
      saved: { ...IDENTITY_FIELDS, number: 'L01X00T47' },
    });
    renderIdentity();
    fireEvent.click(screen.getByRole('button', { name: 'Person ändern' }));
    expect(screen.getByText(/Die zugeordnete Person wurde geändert/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Als geprüft markieren' }));
    });
    expect(submitted(h.updateIdDocuments, 0)).toMatchObject({
      intent: 'confirm',
      expectedRevision: 'rev-invalidated',
    });
    await waitFor(() =>
      expect(screen.queryByText(/Die zugeordnete Person wurde geändert/)).toBeNull(),
    );
    expect(screen.getByText('Angaben bestätigt')).toBeTruthy();
  });

  it('führt Vertreter als strukturierte Personen statt als Mehrzeilen-Freitext', async () => {
    const representatives = [
      { id: 'rep-1', fullName: 'Erika Vertreterin', position: 0, linkedBeneficialOwnerId: null },
    ];
    const current = {
      legalForm: 'GmbH',
      registerNumber: 'HRB 1',
      registerAuthority: 'AG Gießen',
      noRegisterEntry: false,
      representatives,
      ownershipStructureNotes: null,
    };
    const legal = render(
      el(LegalEntityDetailsForm, {
        checkId: CHECK_ID,
        clientId: CLIENT_ID,
        current,
        currentRevision: 'rev-1',
        disabled: false,
      }),
    );
    const legalJson = legal.container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="representativesJson"]',
    )!;
    expect(JSON.parse(legalJson.value)).toEqual([
      { id: 'rep-1', fullName: 'Erika Vertreterin', isNew: false, linkedBeneficialOwnerId: null },
    ]);
    expect(legal.container.querySelector('[name="representativeNamesText"]')).toBeNull();
    expect(legal.container.querySelector('textarea[name*="representative"]')).toBeNull();
    legal.unmount();

    h.addOwnerRole.mockResolvedValue({ ok: true, createdOwnerId: 'owner-9' });
    const roles = render(
      el(PersonRolesPanel, {
        checkId: CHECK_ID,
        clientId: CLIENT_ID,
        personName: 'Erika Vertreterin',
        roleLabels: ['Gesetzliche Vertretung'],
        owner: null,
        representativeId: 'rep-1',
        current,
        currentRevision: 'rev-1',
        disabled: false,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    expect(screen.getByText(/können hier nicht frei eingegeben werden/)).toBeTruthy();
    expect(roles.container.querySelector('input[name="fullName"]')).toBeNull();
    expect(roles.container.querySelector('[name="representativeNamesText"]')).toBeNull();
    const rolesJson = roles.container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="representativesJson"]',
    )!;
    expect(JSON.parse(rolesJson.value)).toEqual([
      expect.objectContaining({ id: 'rep-1', fullName: 'Erika Vertreterin', isNew: false }),
    ]);

    expect(screen.queryByRole('button', { name: 'Doppelrolle speichern' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wirtschaftlich berechtigt' }));
    fireEvent.change(screen.getByLabelText('Anteil (%)'), { target: { value: '30' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Doppelrolle speichern' }));
    });
    expect(Object.fromEntries(h.addOwnerRole.mock.calls[0]![1] as FormData)).toEqual({
      checkId: CHECK_ID,
      clientId: CLIENT_ID,
      representativeId: 'rep-1',
      ownershipPct: '30',
    });
    roles.unmount();

    render(el(NewGwgPersonForm, { checkId: CHECK_ID, clientId: CLIENT_ID }));
    fireEvent.click(screen.getByRole('button', { name: 'Neue Person erfassen' }));
    expect(screen.getByRole('heading', { name: 'Neue Person erfassen' })).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).name).toBe('fullName');
  });

  it('zeigt die Rollendaten eines Berechtigten im Bearbeitungsmodus sofort aufgeklappt', () => {
    render(
      el(PersonRolesPanel, {
        checkId: CHECK_ID,
        clientId: CLIENT_ID,
        personName: 'Max Muster',
        roleLabels: ['Wirtschaftlich berechtigt'],
        owner: {
          id: 'owner-1',
          fullName: 'Max Muster',
          birthDate: '1980-02-01',
          birthPlace: 'Alsfeld',
          residence: 'Hauptstr. 1, 36304 Alsfeld',
          nationality: 'DE',
          ownershipPct: '100',
          isPep: false,
          revision: 'owner-rev-1',
        },
        representativeId: null,
        current: {
          legalForm: 'GmbH',
          registerNumber: null,
          registerAuthority: null,
          noRegisterEntry: false,
          representatives: [],
          ownershipStructureNotes: null,
        },
        currentRevision: 'rev-1',
        disabled: false,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    const ownerDetails = screen
      .getByText('Angaben zur wirtschaftlichen Berechtigung')
      .closest('details')!;
    expect(ownerDetails.open).toBe(true);
  });

  it('aktualisiert Kopfstatus und Owner-Zusammenfassung ohne Seitenreload', async () => {
    function Controls() {
      const { markDraft, markInReview } = useGwgEditState();
      return el(
        'div',
        null,
        el('button', { type: 'button', onClick: markDraft }, 'Entwurf markieren'),
        el('button', { type: 'button', onClick: markInReview }, 'Einreichen markieren'),
      );
    }
    const tree = (initialStatus: 'DRAFT' | 'IN_REVIEW' | 'VERIFIED') =>
      provider(GwgEditStateProvider, { initialStatus }, el(GwgLiveStatusBadge), el(Controls));
    const { rerender, unmount } = render(tree('IN_REVIEW'));
    expect(screen.getByText('In Prüfung')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf markieren' }));
    expect(screen.getByText('Entwurf')).toBeTruthy();
    // Ein Refresh mit derselben, noch alten Serverprop dreht den lokalen
    // Erfolg nicht zurück; ein neuer Serverstatus wird übernommen.
    rerender(tree('IN_REVIEW'));
    expect(screen.getByText('Entwurf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Einreichen markieren' }));
    expect(screen.getByText('In Prüfung')).toBeTruthy();
    rerender(tree('VERIFIED'));
    expect(screen.getByText('Verifiziert')).toBeTruthy();
    unmount();

    h.updateOwner.mockResolvedValueOnce({
      ok: true,
      revision: 'owner-rev-2',
      saved: {
        id: 'owner-1',
        fullName: 'Max Neu',
        birthDate: '1980-02-01',
        birthPlace: 'Alsfeld',
        residence: 'Hauptstr. 1, 36304 Alsfeld',
        nationality: 'DE',
        ownershipPct: '50',
        isPep: false,
      },
    });
    render(
      el(BeneficialOwnerForm, {
        ownerId: 'owner-1',
        checkId: CHECK_ID,
        clientId: CLIENT_ID,
        value: {
          fullName: 'Max Muster',
          birthDate: '1980-02-01',
          birthPlace: 'Alsfeld',
          residence: 'Hauptstr. 1, 36304 Alsfeld',
          nationality: 'DE',
          ownershipPct: '100',
          isPep: false,
        },
        revision: 'owner-rev-1',
        defaultOpen: true,
      }),
    );
    expect(screen.getByText('Anteil: 100.00 %')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Anteil (%)'), { target: { value: '50' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rollendaten speichern' }));
    });
    await waitFor(() => expect(screen.getByText('Anteil: 50.00 %')).toBeTruthy());
    expect(h.refresh).toHaveBeenCalledOnce();

    h.removeOwner.mockResolvedValueOnce({ ok: false, error: 'abgelehnt' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Nicht mehr wirtschaftlich berechtigt' }));
    });
    expect(h.confirmMessages).toEqual([
      'Max Neu wirklich aus dem aktuellen Prüfsnapshot entfernen? Zugeordnete Ausweise müssen danach neu zugeordnet werden.',
    ]);
    await waitFor(() => expect(h.removeOwner).toHaveBeenCalledOnce());
    expect(Object.fromEntries(h.removeOwner.mock.calls[0]![1] as FormData)).toMatchObject({
      expectedRevision: 'owner-rev-2',
    });
  });

  // Fachkatalog: GWG-BENEFICIAL-OWNERS-001, GWG-REPRESENTATIVE-AUTHORITY-001,
  // GWG-IDENTIFICATION-EVIDENCE-001
  it('gleicht veraltete allgemeine Personenangaben ohne manuellen Seitenreload ab', async () => {
    const value = {
      fullName: 'Max Muster',
      birthDate: '1980-02-01',
      birthPlace: 'Alsfeld',
      residence: 'Hauptstr. 1, 36304 Alsfeld',
      nationality: 'DE',
      isPep: false,
    };
    h.updatePersonGeneral.mockResolvedValueOnce({
      ok: false,
      conflict: true,
      error: 'Die Angaben wurden zwischenzeitlich geändert.',
      revision: 'person-rev-2',
      latest: { ...value, fullName: 'Max Muster-Neu' },
    });
    const { container } = render(
      el(PersonGeneralForm, {
        ownerId: 'owner-1',
        representativeId: null,
        checkId: CHECK_ID,
        clientId: CLIENT_ID,
        value,
        revision: 'person-rev-1',
        disabled: false,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    fireEvent.change(screen.getByLabelText('Geburtsort'), { target: { value: 'Gießen' } });
    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });

    const notice = await screen.findByText(/Ihre Änderungen sind erhalten/);
    expect(h.refresh).toHaveBeenCalled();
    // Lokale Eingabe bleibt, unberührte Felder ziehen den neuen Serverstand nach.
    expect((screen.getByLabelText('Geburtsort') as HTMLInputElement).value).toBe('Gießen');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Max Muster-Neu');
    expect(container.querySelector<HTMLInputElement>('input[name="expectedRevision"]')!.value).toBe(
      'person-rev-2',
    );

    fireEvent.click(
      within(notice.parentElement!).getByRole('button', {
        name: 'Hinweis zum automatischen Abgleich schließen',
      }),
    );
    expect(screen.queryByText(/Ihre Änderungen sind erhalten/)).toBeNull();
  });
});
