// @vitest-environment jsdom
// Fachkatalog: GWG-OCR-ASSIST-001, GWG-SELF-ONBOARDING-001
// Mandanten-Onboarding: Angaben aus der Ausweishilfe werden sichtbar im
// Formular markiert, bis der Mandant sie selbst bearbeitet. Die Hilfe läuft in
// der Mandantenfassung; eine Bestätigung entsteht nicht.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';
import type { IdentitySuggestions } from '@/lib/gwg/identity-ocr';
import type { LoadedInviteDraftOwner } from '@/server/gwg-onboarding/service';

const h = vi.hoisted(() => ({ audiences: [] as string[] }));

vi.mock('../actions', () => ({
  uploadIdImageAction: vi.fn(),
  discardOnboardingUploadAction: vi.fn(),
  submitOnboardingAction: vi.fn(),
  loadOnboardingIdentitySourceAction: vi.fn(),
}));
// Stub statt OCR: übernimmt Vorschläge wie die echte Hilfe über onApply.
vi.mock('@/components/gwg/identity-capture', () => ({
  IdentityCapture: (props: {
    audience?: string;
    onApply: (fields: IdentitySuggestions) => void;
  }) => {
    h.audiences.push(props.audience ?? 'staff');
    return (
      <button
        type="button"
        onClick={() =>
          props.onApply({
            fullName: 'ERIKA MUSTERMANN',
            idNumber: 'LZ6311T47',
            idExpiryDate: '2034-05-01',
          })
        }
      >
        Vorschläge übernehmen (Test)
      </button>
    );
  },
}));

import { OnboardingWizard } from '../wizard';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const idFile = (n: number, side: 'front' | 'back') => ({
  documentId: uuid(n),
  fileName: `ausweis-${side}.jpg`,
  versionId: uuid(100 + n),
  viewport: fullIdentityViewport(uuid(100 + n), side),
});
const OWNER: LoadedInviteDraftOwner = {
  id: 'owner-1',
  fullName: 'Vorhandener Name',
  birthDate: '1983-08-12',
  birthPlace: 'Berlin',
  nationality: 'DE',
  street: 'Heidestraße 17',
  postalCode: '51147',
  city: 'Köln',
  countryIso: 'DE',
  sharePercent: '100%',
  isPep: false,
  idType: 'PERSONALAUSWEIS',
  idNumber: '',
  idIssuedBy: '',
  idIssueDate: '',
  idExpiryDate: '',
  idFront: idFile(1, 'front'),
  idBack: idFile(2, 'back'),
};

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});

function renderOwnersStep() {
  render(
    <OnboardingWizard
      token="token-1"
      inviteName="Erika Mustermann"
      client={{
        id: 'client-1',
        name: 'Muster GmbH',
        kind: 'JURPERS',
        street: 'Hauptstr. 1',
        postalCode: '36304',
        city: 'Alsfeld',
        countryIso: 'DE',
      }}
      initialDraft={{
        checkId: 'check-1',
        noRegisterEntry: null,
        owners: [OWNER],
        representatives: [],
        extraDocuments: [],
      }}
      noticeBody="Datenschutzhinweise"
      noticeVersion={1}
      consentOptions={[]}
      consentDisplayRevision="rev-1"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
  return screen
    .getByRole('heading', { level: 3, name: 'Person 1' })
    .closest('.card') as HTMLElement;
}

describe('GWG-OCR-ASSIST-001 sichtbare Übernahme im Mandanten-Onboarding', () => {
  it('nutzt die Mandantenfassung und markiert übernommene Felder bis zur eigenen Bearbeitung', () => {
    const card = renderOwnersStep();
    expect(h.audiences.at(-1)).toBe('client');
    expect(card.querySelectorAll('[data-identity-applied="true"]')).toHaveLength(0);

    fireEvent.click(within(card).getByRole('button', { name: 'Vorschläge übernehmen (Test)' }));

    const name = within(card).getByLabelText(/Vollständiger Name/) as HTMLInputElement;
    const number = within(card).getByLabelText(/Ausweisnummer/) as HTMLInputElement;
    const expiry = within(card).getByLabelText(/Gültig bis/) as HTMLInputElement;
    expect([name.value, number.value, expiry.value]).toEqual([
      'ERIKA MUSTERMANN',
      'LZ6311T47',
      '2034-05-01',
    ]);
    for (const input of [name, number, expiry]) {
      expect(input.dataset.identityApplied).toBe('true');
      // Der Hinweis ist dem Feld zugeordnet (Screenreader liest ihn mit).
      expect(document.getElementById(input.getAttribute('aria-describedby')!)?.textContent).toBe(
        'Aus dem Ausweis übernommen – bitte prüfen.',
      );
    }
    // Nicht übernommene Felder bleiben unmarkiert.
    const birthPlace = within(card).getByLabelText(/Geburtsort/) as HTMLInputElement;
    expect(birthPlace.dataset.identityApplied).toBeUndefined();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();

    // Eigene Bearbeitung beendet die Markierung nur für dieses Feld.
    fireEvent.change(number, { target: { value: 'LZ6311T48' } });
    expect(number.dataset.identityApplied).toBeUndefined();
    expect(number.getAttribute('aria-describedby')).toBeNull();
    expect(name.dataset.identityApplied).toBe('true');
    expect(within(card).getAllByText('Aus dem Ausweis übernommen – bitte prüfen.')).toHaveLength(2);
  });
});
