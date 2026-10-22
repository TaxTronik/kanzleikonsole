// @vitest-environment jsdom
// Fachkatalog: GWG-SELF-ONBOARDING-001
// GwG-Onboarding-Wizard als Verhaltenstest (B-08, Welle 15) statt
// Quelltextprüfung: Schrittfolge, explizite Doppelrollen-Entscheidung,
// Übermittlung mit stabilen lokalen IDs, generische Ausweis-Uploads für beide
// Rollen und die gekoppelte Register-/Dokumenttyp-Auswahl. Ersetzt
// wizard-representatives.test.ts und die Verhaltensteile von
// wizard-steps-structure.test.ts (dort bleibt nur der Architektur-Guard). Der
// Personenschritt zeigt eine Übersicht; bearbeitet wird eine Person nach der anderen.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';
import type { ResolvedConsentOption } from '@/server/privacy/consent';
import type {
  LoadedInviteDraft,
  LoadedInviteDraftOwner,
  LoadedInviteDraftRepresentative,
} from '@/server/gwg-onboarding/service';

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  discard: vi.fn(),
  submit: vi.fn(),
  calls: [] as string[],
}));

vi.mock('../actions', () => ({
  uploadIdImageAction: h.upload,
  discardOnboardingUploadAction: h.discard,
  submitOnboardingAction: h.submit,
  loadOnboardingIdentitySourceAction: vi.fn(),
}));
// Die Ausweishilfe (PDF-/Bildvorschau) ist für diese Abläufe nicht nötig.
vi.mock('@/components/gwg/identity-capture', () => ({ IdentityCapture: () => null }));

import { OnboardingWizard } from '../wizard';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CLIENT = {
  id: 'client-1',
  name: 'Muster GmbH',
  kind: 'JURPERS' as const,
  street: 'Hauptstr. 1',
  postalCode: '36304',
  city: 'Alsfeld',
  countryIso: 'DE',
};

function idFile(n: number, side: 'front' | 'back') {
  return {
    documentId: uuid(n),
    fileName: `ausweis-${side}-${n}.pdf`,
    versionId: uuid(100 + n),
    viewport: fullIdentityViewport(uuid(100 + n), side),
  };
}

const OWNER: LoadedInviteDraftOwner = {
  id: 'owner-draft-1',
  fullName: 'Max Muster',
  birthDate: '1980-02-01',
  birthPlace: 'Alsfeld',
  nationality: 'DE',
  street: 'Hauptstr. 1',
  postalCode: '36304',
  city: 'Alsfeld',
  countryIso: 'DE',
  sharePercent: '100%',
  isPep: false,
  idType: 'PERSONALAUSWEIS',
  idNumber: 'L01X00T47',
  idIssuedBy: 'Stadt Alsfeld',
  idIssueDate: '2020-01-15',
  idExpiryDate: '2030-01-14',
  idFront: idFile(1, 'front'),
  idBack: idFile(2, 'back'),
};

function representative(
  overrides: Partial<LoadedInviteDraftRepresentative>,
): LoadedInviteDraftRepresentative {
  return {
    id: 'rep-1',
    fullName: '',
    linkedOwnerId: null,
    idType: 'PERSONALAUSWEIS',
    idNumber: '',
    idIssuedBy: '',
    idIssueDate: '',
    idExpiryDate: '',
    idFront: null,
    idBack: null,
    ...overrides,
  };
}

function draft(overrides: Partial<LoadedInviteDraft> = {}): LoadedInviteDraft {
  return {
    checkId: 'check-1',
    noRegisterEntry: null,
    owners: [OWNER],
    representatives: [],
    extraDocuments: [],
    ...overrides,
  };
}

function renderWizard(
  initialDraft: LoadedInviteDraft | null,
  consentOptions: ResolvedConsentOption[] = [],
) {
  return render(
    <OnboardingWizard
      token="token-1"
      inviteName="Max Muster"
      client={CLIENT}
      initialDraft={initialDraft}
      noticeBody="Datenschutzhinweise der Kanzlei"
      noticeVersion={1}
      consentOptions={consentOptions}
      consentDisplayRevision="rev-1"
    />,
  );
}

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
const stepHeading = (name: string) => screen.getByRole('heading', { level: 2, name });

/** Öffnet eine Person aus der Übersicht und liefert ihre Bearbeitung. */
function openPerson(title: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${title}: `) }));
  return editor(title);
}

function editor(title: string): HTMLElement {
  return screen.getByRole('heading', { level: 2, name: title }).closest('.card') as HTMLElement;
}

function section(scope: HTMLElement, label: string) {
  fireEvent.click(within(scope).getByRole('button', { name: new RegExp(`^\\d\\. ${label}`) }));
}

const backToOverview = () => fireEvent.click(screen.getByRole('button', { name: 'Zur Übersicht' }));

function identitySelect(scope: HTMLElement): HTMLSelectElement {
  return within(scope).getByLabelText(
    'Ist diese Person bereits wirtschaftlich berechtigt?',
  ) as HTMLSelectElement;
}

/** Eingabe eines Feldes, dessen <label> (ohne htmlFor) direkt davor steht. */
function field(scope: HTMLElement, label: string): HTMLInputElement {
  const element = [...scope.querySelectorAll('label')].find(
    (entry) => entry.textContent?.replace('*', '').trim() === label,
  );
  return element!.nextElementSibling as HTMLInputElement;
}

function uploadInput(scope: HTMLElement, label: string): HTMLInputElement {
  const element = [...scope.querySelectorAll('label')].find(
    (entry) => entry.textContent?.replace('*', '').trim() === label,
  );
  return element!.parentElement!.querySelector('input[type="file"]') as HTMLInputElement;
}

/**
 * Wählt eine Datei wie der Browser: Das Zurücksetzen von `value` leert auch
 * `files`. Liest der Handler die Datei erst nach dem Zurücksetzen, kommt kein
 * Upload an.
 */
function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'value', {
    configurable: true,
    get: () => '',
    set: (value: string) => {
      h.calls.push(`reset:${value}`);
      Object.defineProperty(input, 'files', { configurable: true, value: [] });
    },
  });
  fireEvent.change(input, { target: { files: [file] } });
}

function uploadedFile(call: number): File {
  return (h.upload.mock.calls[call]![1] as FormData).get('file') as File;
}

let uploadSeq = 0;

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  uploadSeq = 0;
  h.upload.mockImplementation(async () => {
    h.calls.push('upload');
    uploadSeq += 1;
    return { ok: true, documentId: uuid(10 + uploadSeq), versionId: uuid(110 + uploadSeq) };
  });
  h.discard.mockResolvedValue({ ok: true });
  h.submit.mockResolvedValue({ ok: true });
});

describe('GwG-Onboarding – Schrittfolge', () => {
  it('führt mit Stepper und Navigation durch die fünf Schritte', async () => {
    renderWizard(
      draft({
        noRegisterEntry: false,
        representatives: [representative({ id: 'rep-linked', linkedOwnerId: OWNER.id })],
        extraDocuments: [
          { documentId: uuid(5), fileName: 'hr.pdf', type: 'HANDELSREGISTERAUSZUG' },
        ],
      }),
    );
    const current = () =>
      [...screen.getByRole('list', { name: 'Fortschritt' }).querySelectorAll('span')]
        .filter((span) => span.className.includes('font-medium'))
        .map((span) => span.textContent);

    expect(stepHeading('Stammdaten')).toBeTruthy();
    expect(current()).toEqual(['Stammdaten']);
    expect((screen.getByRole('button', { name: 'Zurück' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    next();
    expect(stepHeading('Wirtschaftlich Berechtigte')).toBeTruthy();
    expect(current()).toEqual(['Wirtschaftlich Berechtigte']);
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    expect(stepHeading('Stammdaten')).toBeTruthy();
    next();
    next();
    expect(stepHeading('Rechtsträgernachweise')).toBeTruthy();
    next();
    expect(stepHeading('Datenschutz')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
      }),
    );
    next();
    expect(stepHeading('Zusammenfassung')).toBeTruthy();
    expect(current()).toEqual(['Übermitteln']);
    expect(screen.queryByRole('button', { name: 'Weiter' })).toBeNull();
  });
});

describe('GwG-Onboarding – explizite Doppelrollen-UX', () => {
  it('startet neutral mit ausdrücklicher Auswahl zwischen eigener Person und Doppelrolle', () => {
    renderWizard(null);
    next();
    const select = identitySelect(openPerson('Vertretung 1'));
    expect(select.value).toBe('');
    expect([...select.options].map((option) => [option.textContent, option.disabled])).toEqual([
      ['— bitte ausdrücklich auswählen —', true],
      ['Nein – eigenständige Person erfassen', false],
      ['Ja – Max Muster (dieselbe Person)', false],
    ]);
  });

  it('blockiert Weiter ohne bewusste Rollenentscheidung', () => {
    renderWizard(draft());
    next();
    // Eine neue Vertretung öffnet sich direkt zur Bearbeitung.
    fireEvent.click(screen.getByRole('button', { name: /Weitere Vertretung hinzufügen/ }));
    expect(identitySelect(editor('Vertretung 1')).value).toBe('');

    backToOverview();
    next();
    expect(
      screen.getByText(
        'Vertretung 1: Bitte entscheiden Sie ausdrücklich, ob dieselbe Person bereits wirtschaftlich berechtigt ist.',
      ),
    ).toBeTruthy();
    expect(stepHeading('Wirtschaftlich Berechtigte')).toBeTruthy();

    fireEvent.change(identitySelect(openPerson('Vertretung 1')), { target: { value: OWNER.id } });
    const linked = editor('Vertretung 1');
    expect(linked.textContent).toContain('Max Muster wird mit beiden Rollen gespeichert');
    expect(linked.querySelector('input[type="file"]')).toBeNull();
    // Bei der Doppelrolle bleibt nur die Rollenentscheidung.
    fireEvent.click(within(linked).getByRole('button', { name: /Fertig – zur Übersicht/ }));
    next();
    expect(stepHeading('Rechtsträgernachweise')).toBeTruthy();
  });

  it('übermittelt stabile lokale IDs und entweder Owner-Link oder eigenen Ausweis', async () => {
    renderWizard(
      draft({
        noRegisterEntry: false,
        representatives: [
          representative({ id: 'rep-linked', linkedOwnerId: OWNER.id }),
          representative({
            id: 'rep-separate',
            fullName: 'Erika Beispiel',
            idNumber: 'T22000129',
            idIssuedBy: 'Stadt Gießen',
            idIssueDate: '2021-03-01',
            idExpiryDate: '2031-02-28',
            idFront: idFile(3, 'front'),
            idBack: idFile(4, 'back'),
          }),
        ],
        extraDocuments: [
          { documentId: uuid(5), fileName: 'hr.pdf', type: 'HANDELSREGISTERAUSZUG' },
        ],
      }),
    );
    next();
    next();
    next();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
      }),
    );
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt übermitteln' }));

    await waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    const [payload] = h.submit.mock.calls[0]!;
    expect(payload.owners).toEqual([
      expect.objectContaining({
        localId: OWNER.id,
        idFrontDocumentId: uuid(1),
        idBackDocumentId: uuid(2),
      }),
    ]);
    expect(payload.representatives).toEqual([
      expect.objectContaining({
        localId: 'rep-linked',
        fullName: 'Max Muster',
        linkedOwnerLocalId: OWNER.id,
        idFrontDocumentId: null,
        idBackDocumentId: null,
      }),
      expect.objectContaining({
        localId: 'rep-separate',
        fullName: 'Erika Beispiel',
        linkedOwnerLocalId: null,
        idFrontDocumentId: uuid(3),
        idBackDocumentId: uuid(4),
      }),
    ]);
    expect(await screen.findByRole('heading', { name: 'Vielen Dank!' })).toBeTruthy();
  });
});

describe('GwG-Onboarding – Personenübersicht', () => {
  const chips = (title: string) =>
    [
      ...(
        screen.getByRole('heading', { level: 3, name: title }).closest('li') as HTMLElement
      ).querySelectorAll('ul > li'),
    ].map((chip) => chip.textContent);

  it('zeigt je Person den Stand und führt durch Ausweis, Angaben, Beteiligung und PEP', () => {
    renderWizard(null);
    next();
    expect(chips('Person 1')).toEqual([
      'Ausweis offen',
      'Angaben offen',
      'Beteiligung und PEP offen',
    ]);

    const person = openPerson('Person 1');
    // Während der Bearbeitung führt nur die Person; die Schrittnavigation ruht.
    expect(screen.queryByRole('button', { name: 'Weiter' })).toBeNull();
    expect(
      within(person)
        .getAllByRole('button', { name: /^\d\. / })
        .map((button) => button.textContent),
    ).toEqual(['1. Ausweis', '2. Angaben', '3. Beteiligung und PEP']);
    expect(within(person).getByRole('heading', { level: 3, name: 'Ausweis' })).toBeTruthy();
    expect(within(person).queryByLabelText(/Geburtsort/)).toBeNull();

    fireEvent.click(within(person).getByRole('button', { name: /Weiter: Angaben/ }));
    expect(within(person).getByLabelText(/Geburtsort/)).toBeTruthy();
    fireEvent.click(within(person).getByRole('button', { name: /Weiter: Beteiligung und PEP/ }));
    fireEvent.change(field(person, 'Anteil (z. B. 50% oder „Alleingesellschafter")'), {
      target: { value: '100%' },
    });
    fireEvent.change(within(person).getByLabelText(/Politisch exponierte Person/), {
      target: { value: 'false' },
    });
    fireEvent.click(within(person).getByRole('button', { name: /Fertig – zur Übersicht/ }));

    expect(chips('Person 1')).toEqual([
      'Ausweis offen',
      'Angaben offen',
      'Beteiligung und PEP erledigt',
    ]);
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeTruthy();
  });

  it('öffnet eine neue Person direkt und bietet vollständige Personen zum Bearbeiten an', () => {
    renderWizard(draft({ representatives: [representative({ linkedOwnerId: OWNER.id })] }));
    next();
    expect(screen.getByRole('button', { name: 'Person 1: Bearbeiten' })).toBeTruthy();
    expect(chips('Vertretung 1')).toEqual(['Rolle erledigt']);

    fireEvent.click(screen.getByRole('button', { name: /Weitere Person hinzufügen/ }));
    const added = editor('Person 2');
    expect((field(added, 'Vollständiger Name') as HTMLInputElement).value).toBe('');
    backToOverview();
    expect(screen.getByRole('button', { name: 'Person 2: Angaben ergänzen' })).toBeTruthy();
  });

  it('ergänzt vergessene Personen aus der Zusammenfassung und kehrt dorthin zurück', async () => {
    renderWizard(
      draft({
        noRegisterEntry: false,
        representatives: [representative({ id: 'rep-linked', linkedOwnerId: OWNER.id })],
        extraDocuments: [
          { documentId: uuid(5), fileName: 'hr.pdf', type: 'HANDELSREGISTERAUSZUG' },
        ],
      }),
    );
    next();
    next();
    next();
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
      }),
    );
    next();
    const summary = stepHeading('Zusammenfassung').closest('.card') as HTMLElement;
    // Namen statt bloßer Anzahl, damit eine fehlende Person auffällt.
    expect(summary.textContent).toContain('Max Muster (Doppelrolle)');

    fireEvent.click(
      within(summary).getByRole('button', { name: /Wirtschaftlich berechtigte Person hinzufügen/ }),
    );
    // Die neue Person öffnet sich direkt im Personenschritt.
    fireEvent.click(within(editor('Person 2')).getByRole('button', { name: 'Zur Übersicht' }));
    const back = screen.getByRole('button', { name: 'Weiter zur Zusammenfassung' });
    // Die Pflichtprüfung gilt auch auf dem Rückweg.
    fireEvent.click(back);
    expect(screen.getByText(/^Person 2: .* fehlt oder ist ungültig\.$/)).toBeTruthy();
    expect(stepHeading('Wirtschaftlich Berechtigte')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Person 2 entfernen' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 3, name: 'Person 2' })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Weiter zur Zusammenfassung' }));
    // Nachweise und Datenschutz bleiben erhalten; es geht direkt zurück.
    expect(stepHeading('Zusammenfassung')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Weiter zur Zusammenfassung' })).toBeNull();
  });
});

describe('GwG-Onboarding – Datenschutz-Auswahl', () => {
  // Fachkatalog: DSGVO-CONSENT-SNAPSHOT-001
  it('verlangt Pflichtoptionen und bindet die Erklärung an die angezeigte Revision', async () => {
    const required: ResolvedConsentOption = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      builtin: false,
      section: 'OTHER',
      label: 'Eigene Bestätigung',
      description: null,
      active: true,
      required: true,
      recommended: false,
      sortOrder: 200,
      serviceProviderId: null,
      serviceProvider: null,
      providerMissing: false,
    };
    renderWizard(
      draft({
        noRegisterEntry: false,
        representatives: [representative({ id: 'rep-linked', linkedOwnerId: OWNER.id })],
        extraDocuments: [
          { documentId: uuid(5), fileName: 'hr.pdf', type: 'HANDELSREGISTERAUSZUG' },
        ],
      }),
      [required],
    );
    next();
    next();
    next();
    const option = screen.getByRole('checkbox', { name: /Eigene Bestätigung/ }) as HTMLInputElement;
    expect(option.checked).toBe(false);
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
      }),
    );
    next();
    expect(
      screen.getByText('Bitte bestätigen Sie die folgenden Pflichtoptionen: Eigene Bestätigung.'),
    ).toBeTruthy();
    expect(stepHeading('Datenschutz')).toBeTruthy();

    fireEvent.click(option);
    next();
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt übermitteln' }));
    await waitFor(() => expect(h.submit).toHaveBeenCalledOnce());
    const [payload] = h.submit.mock.calls[0]!;
    expect(payload.consent).toMatchObject({
      noticeAcknowledged: true,
      signedByName: 'Max Muster',
      displayRevision: 'rev-1',
    });
    expect(payload.consent.selections.optionSelections).toEqual([
      expect.objectContaining({ optionId: required.id }),
    ]);
  });
});

describe('GwG-Onboarding – Ausweis- und Nachweis-Uploads', () => {
  it('lädt Ausweise für Berechtigte und Vertretungen über denselben Ablauf hoch', async () => {
    renderWizard(null);
    next();

    // Der Ausweis ist der erste Abschnitt einer Person.
    const ownerFront = new File(['vorne'], 'vorne.png', { type: 'image/png' });
    selectFile(uploadInput(openPerson('Person 1'), 'Personalausweis Vorderseite'), ownerFront);
    await waitFor(() => expect(within(editor('Person 1')).getByText('vorne.png')).toBeTruthy());
    expect(h.upload).toHaveBeenLastCalledWith(
      { token: 'token-1', kind: 'ID_DOCUMENT', personName: 'Max Muster' },
      expect.any(FormData),
    );
    expect(uploadedFile(0)).toBe(ownerFront);

    backToOverview();
    const representativeEditor = openPerson('Vertretung 1');
    fireEvent.change(identitySelect(representativeEditor), { target: { value: 'SEPARATE' } });
    fireEvent.change(field(representativeEditor, 'Vollständiger Name'), {
      target: { value: 'Erika Beispiel' },
    });
    section(representativeEditor, 'Ausweis');
    const representativeBack = new File(['hinten'], 'hinten.png', { type: 'image/png' });
    selectFile(uploadInput(representativeEditor, 'Personalausweis Rückseite'), representativeBack);
    await waitFor(() =>
      expect(within(editor('Vertretung 1')).getByText('hinten.png')).toBeTruthy(),
    );
    expect(h.upload).toHaveBeenLastCalledWith(
      { token: 'token-1', kind: 'ID_DOCUMENT', personName: 'Erika Beispiel' },
      expect.any(FormData),
    );
    expect(uploadedFile(1)).toBe(representativeBack);
    expect(h.calls).toEqual(['upload', 'reset:', 'upload', 'reset:']);
    backToOverview();
    expect(within(openPerson('Person 1')).queryByText('hinten.png')).toBeNull();
    backToOverview();

    // Wird die Vertretung nachträglich mit dem Berechtigten verknüpft, verwirft
    // der Wizard ihren eigenen Ausweis.
    const select = identitySelect(openPerson('Vertretung 1'));
    const ownerOption = [...select.options].find(
      (option) => option.textContent === 'Ja – Max Muster (dieselbe Person)',
    )!;
    fireEvent.change(select, { target: { value: ownerOption.value } });
    await waitFor(() =>
      expect(h.discard).toHaveBeenCalledWith({ token: 'token-1', documentId: uuid(12) }),
    );
  });

  it('koppelt Registerstatus und Dokumenttyp und setzt die Dateiauswahl nach dem Upload zurück', async () => {
    renderWizard(
      draft({ representatives: [representative({ id: 'rep-linked', linkedOwnerId: OWNER.id })] }),
    );
    next();
    next();
    expect(stepHeading('Rechtsträgernachweise')).toBeTruthy();
    const type = screen.getByLabelText('Dokumenttyp') as HTMLSelectElement;
    const register = screen.getByLabelText('Registerstatus des Rechtsträgers') as HTMLSelectElement;
    expect(type.value).toBe('GESELLSCHAFTSVERTRAG');

    fireEvent.change(type, { target: { value: 'VOLLMACHT' } });
    fireEvent.change(register, { target: { value: 'NO_REGISTER' } });
    expect(register.value).toBe('NO_REGISTER');
    expect(type.value).toBe('GESELLSCHAFTSVERTRAG');
    expect(screen.getByText(/nicht registerpflichtige Gesellschaft wird kein/)).toBeTruthy();

    fireEvent.change(type, { target: { value: 'HANDELSREGISTERAUSZUG' } });
    fireEvent.change(register, { target: { value: 'REGISTERED' } });
    expect(type.value).toBe('HANDELSREGISTERAUSZUG');

    const evidence = new File(['hr'], 'registerauszug.pdf', { type: 'application/pdf' });
    const stepCard = stepHeading('Rechtsträgernachweise').closest('.card') as HTMLElement;
    selectFile(stepCard.querySelector('input[type="file"]') as HTMLInputElement, evidence);
    expect(h.calls).toEqual(['upload', 'reset:']);
    expect(h.upload).toHaveBeenCalledWith(
      { token: 'token-1', kind: 'EXTRA', personName: undefined },
      expect.any(FormData),
    );
    expect(uploadedFile(0)).toBe(evidence);
    const item = (await screen.findByText('registerauszug.pdf')).closest('li')!;
    expect(item.textContent).toContain('Handelsregisterauszug');
  });
});
