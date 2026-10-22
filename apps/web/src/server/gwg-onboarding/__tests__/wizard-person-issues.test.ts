// Fachkatalog: GWG-SELF-ONBOARDING-001
// Rückmeldung im Personenschritt: alle offenen Angaben je Person in
// Alltagssprache, mit Abschnitt für den Sprung in die Bearbeitung. Grundlage
// bleibt der Submit-Vertrag; nur die Darstellung ändert sich.
import { describe, expect, it } from 'vitest';
import { fullIdentityViewport } from '@/lib/gwg/identity-viewport';
import {
  onboardingPersonIssues,
  onboardingPersonIssueText,
  type WizardOwnerInput,
  type WizardRepresentativeInput,
} from '../wizard-validation';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function owner(overrides: Partial<WizardOwnerInput> = {}): WizardOwnerInput {
  return {
    id: 'owner-1',
    fullName: 'Ada Beispiel',
    birthDate: '1980-01-02',
    birthPlace: 'Berlin',
    nationality: 'DE',
    street: 'Testweg 1',
    postalCode: '10115',
    city: 'Berlin',
    countryIso: 'DE',
    sharePercent: '50',
    isPep: false,
    idType: 'PERSONALAUSWEIS',
    idNumber: 'ID-1',
    idIssuedBy: 'Berlin',
    idIssueDate: '2024-01-01',
    idExpiryDate: '2030-01-01',
    idFront: { documentId: uuid(1), viewport: fullIdentityViewport(uuid(11), 'front') },
    idBack: { documentId: uuid(2), viewport: fullIdentityViewport(uuid(12), 'back') },
    ...overrides,
  };
}

function representative(
  overrides: Partial<WizardRepresentativeInput> = {},
): WizardRepresentativeInput {
  return {
    id: 'rep-1',
    fullName: '',
    linkedOwnerId: 'owner-1',
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

describe('GWG-SELF-ONBOARDING-001 offene Angaben im Personenschritt', () => {
  it('nennt alle fehlenden Angaben einer Person auf einmal, ohne Paragrafen', () => {
    const { persons, general } = onboardingPersonIssues(
      'JURPERS',
      [
        owner(),
        owner({
          id: 'owner-2',
          fullName: '',
          birthPlace: '',
          street: '',
          postalCode: '',
          isPep: null,
          idFront: null,
        }),
      ],
      [representative()],
    );
    expect(general).toBeNull();
    expect(persons).toEqual([
      {
        role: 'owner',
        id: 'owner-2',
        title: 'Person 2',
        section: 'id',
        bySection: {
          id: ['Foto der Vorderseite'],
          details: ['Name', 'Geburtsort', 'Wohnanschrift'],
          share: ['Antwort zur PEP-Frage'],
        },
        items: [
          'Foto der Vorderseite',
          'Name',
          'Geburtsort',
          'Wohnanschrift',
          'Antwort zur PEP-Frage',
        ],
      },
    ]);
    expect(persons[0]!.items.join(' ')).not.toMatch(/§|GwG/);
  });

  it('erklärt ungültige Daten konkret statt nur „fehlt“', () => {
    const { persons } = onboardingPersonIssues(
      'NATPERS',
      [owner({ idIssueDate: '2099-01-01', idExpiryDate: '2099-06-01' })],
      [],
    );
    expect(persons[0]!.items).toContain('Das Ausstellungsdatum darf nicht in der Zukunft liegen.');
    expect(persons[0]!.section).toBe('details');
  });

  it('führt bei Vertretungen zur Rollenentscheidung und meldet Übergreifendes allgemein', () => {
    const undecided = onboardingPersonIssues(
      'JURPERS',
      [owner()],
      [representative({ linkedOwnerId: undefined })],
    );
    expect(undecided.persons).toEqual([
      expect.objectContaining({
        role: 'representative',
        title: 'Vertretung 1',
        section: 'role',
        items: ['Entscheidung, ob die Person bereits wirtschaftlich berechtigt ist'],
      }),
    ]);

    const none = onboardingPersonIssues('JURPERS', [owner()], []);
    expect(none).toEqual({
      persons: [],
      general: 'Bitte erfassen Sie mindestens eine vertretungsberechtigte Person.',
    });
    expect(onboardingPersonIssueText(none)).toBe(none.general);
  });

  it('fasst die erste Person für eine einzeilige Meldung zusammen', () => {
    const issues = onboardingPersonIssues('NATPERS', [owner({ sharePercent: '' })], []);
    expect(onboardingPersonIssueText(issues)).toBe('Person 1: Bitte noch ergänzen – Anteil.');
    expect(onboardingPersonIssueText(onboardingPersonIssues('NATPERS', [owner()], []))).toBeNull();
  });
});
