import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const identityReviewSource = readFileSync(
  new URL('../identity-document-review.tsx', import.meta.url),
  'utf8',
);
const removeButtonSource = readFileSync(
  new URL('../remove-evidence-link-button.tsx', import.meta.url),
  'utf8',
);
const selectCurrentButtonSource = readFileSync(
  new URL('../select-current-identity-set-button.tsx', import.meta.url),
  'utf8',
);
const legalEntityDetailsSource = readFileSync(
  new URL('../legal-entity-details-form.tsx', import.meta.url),
  'utf8',
);
const personRolesSource = readFileSync(
  new URL('../person-roles-panel.tsx', import.meta.url),
  'utf8',
);
const personGeneralSource = readFileSync(
  new URL('../person-general-form.tsx', import.meta.url),
  'utf8',
);
const newPersonSource = readFileSync(
  new URL('../new-gwg-person-form.tsx', import.meta.url),
  'utf8',
);
const beneficialOwnerSource = readFileSync(
  new URL('../beneficial-owner-form.tsx', import.meta.url),
  'utf8',
);
const addDocumentSource = readFileSync(new URL('../add-id-doc-form.tsx', import.meta.url), 'utf8');
const addOwnerRoleSource = readFileSync(
  new URL('../add-beneficial-owner-role-form.tsx', import.meta.url),
  'utf8',
);
const evidenceFormToggleSource = readFileSync(
  new URL('../evidence-form-toggle.tsx', import.meta.url),
  'utf8',
);

describe('GwG-Prüfung Seitenstruktur', () => {
  it('zeigt den Prüfverlauf vor Stepper und Einladung', () => {
    const history = pageSource.indexOf('Prüfverlauf ({checkHistory.length})');
    const stepper = pageSource.indexOf('<Stepper steps={gwgSteps} />');
    const invite = pageSource.indexOf('title="Einladung an den Mandanten"');

    expect(history).toBeGreaterThan(-1);
    expect(history).toBeLessThan(stepper);
    expect(stepper).toBeLessThan(invite);
  });

  it('ordnet Personen direkt nach der Einladung und vor Rechtsträgernachweisen an', () => {
    const invite = pageSource.indexOf('title="Einladung an den Mandanten"');
    const persons = pageSource.indexOf('title="Personen"');
    const register = pageSource.indexOf('title="Rechtsträger- und Registernachweise"');

    expect(invite).toBeLessThan(persons);
    expect(persons).toBeLessThan(register);
  });

  it('zeigt Stammdaten und gesetzliche Vertreter vor Stepper und Einladung', () => {
    const masterData = pageSource.indexOf('Stammdaten und gesetzliche Vertretung');
    const representatives = pageSource.indexOf('Gesetzliche Vertreter');
    const stepper = pageSource.indexOf('<Stepper steps={gwgSteps} />');
    const invite = pageSource.indexOf('title="Einladung an den Mandanten"');
    const register = pageSource.indexOf('title="Rechtsträger- und Registernachweise"');

    expect(masterData).toBeGreaterThan(-1);
    expect(masterData).toBeLessThan(stepper);
    expect(representatives).toBeLessThan(invite);
    expect(stepper).toBeLessThan(invite);
    expect(pageSource.slice(register)).not.toContain('<LegalEntityDetailsForm');
  });

  it('ordnet Personen ausschließlich untereinander über die volle Spaltenbreite an', () => {
    expect(pageSource).toContain('<div className="space-y-3">');
    expect(pageSource).not.toContain('<div className="grid grid-cols-1 gap-3 xl:grid-cols-2">');
  });

  it('rendert jeden Registernachweis als initial geschlossenes Expandable', () => {
    const expandable = '<details key={block.value} className="details-box">';

    expect(pageSource).toContain(expandable);
    expect(pageSource).toContain('grid grid-cols-1 items-start gap-3 xl:grid-cols-2');
    expect(pageSource).not.toContain('<details key={block.value} className="details-box" open');
  });

  it('öffnet Register-Uploadformulare über einen Button und bindet sie an ihren Nachweistyp', () => {
    expect(pageSource).toContain("docs.length > 0 ? 'Nachweis ersetzen' : 'Nachweis hinzufügen'");
    expect(pageSource).toContain('<EvidenceFormToggle');
    expect(evidenceFormToggleSource).toContain('<button');
    expect(evidenceFormToggleSource).toContain('type="button"');
    expect(evidenceFormToggleSource).toContain('className="btn-secondary text-xs"');
    expect(evidenceFormToggleSource).toContain('aria-expanded={open}');
    expect(pageSource).toContain('defaultType={block.value}');
    expect(pageSource).toContain('lockType');
    expect(addDocumentSource).toContain('{lockType ? (');
    expect(addDocumentSource).toContain('<input type="hidden" name="type" value={type} />');
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('bietet den Austausch für Ausweis- und Registernachweise an', () => {
    expect(identityReviewSource).toContain('Ausweis ersetzen');
    expect(identityReviewSource).toContain('setReplacementOpen(true)');
    expect(identityReviewSource).toContain(
      "replacement={{ mode: 'set', documentSetId: group.documentSetId }}",
    );
    expect(pageSource).toContain("replacement={docs.length > 0 ? { mode: 'type' } : undefined}");
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('zeigt Ausweisdaten zuerst lesend und den Austausch erst im Bearbeitungsmodus', () => {
    const readOnlyData = identityReviewSource.indexOf('Ausweisnummer</dt>');
    const editButton = identityReviewSource.indexOf(
      '<Pencil className="h-3.5 w-3.5" /> Bearbeiten',
    );
    const replacement = identityReviewSource.indexOf('Ausweis ersetzen');

    expect(readOnlyData).toBeGreaterThan(-1);
    expect(readOnlyData).toBeLessThan(editButton);
    expect(editButton).toBeLessThan(replacement);
    expect(identityReviewSource).toContain('{editing && !disabled && group.subjectKey && (');
    expect(identityReviewSource).toContain('open={replacementOpen}');
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('bestätigt einen vollständigen gültigen Ausweis direkt aus dem Lesemodus', () => {
    expect(identityReviewSource).toContain('const canConfirmDirectly =');
    expect(identityReviewSource).toContain("'Als geprüft markieren'");
    expect(identityReviewSource).toContain('action={formAction}');
    expect(identityReviewSource).toContain('router.refresh();');
    expect(identityReviewSource).toContain('!hasCompetingActiveSets');
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('zeigt alte Nachweise eingeklappt und entfernt per X nur ihre Prüfzuordnung', () => {
    expect(pageSource).toContain('Alte Ausweise ({groups.length})');
    expect(pageSource).toContain('historicalEvidence={');
    expect(identityReviewSource).toContain('{historicalEvidence}');
    expect(pageSource).toContain('Alte Nachweise ({oldDocs.length})');
    expect(removeButtonSource).toContain('Falschen Upload aus der GwG-Prüfung entfernen');
    expect(removeButtonSource).toContain('Datei und ihre Versionen bleiben in der Mandantenakte');
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('lässt bei einem Doppelbestand bewusst genau einen aktuellen Ausweissatz auswählen', () => {
    expect(identityReviewSource).toContain('hasCompetingActiveSets={groups.length > 1}');
    expect(selectCurrentButtonSource).toContain('Diesen Ausweis als aktuell festlegen');
    expect(selectCurrentButtonSource).toContain('unter „Alte Ausweise“ abgelegt');
  });

  // Fachkatalog: GWG-BENEFICIAL-OWNERS-001, GWG-REPRESENTATIVE-AUTHORITY-001
  it('beginnt mit neuer Person und zeigt Rollen je Person lesend vor der Bearbeitung', () => {
    const persons = pageSource.indexOf('title="Personen"');
    const create = pageSource.indexOf('<NewGwgPersonForm');
    const personList = pageSource.indexOf('{persons.map((person) => (');

    expect(persons).toBeLessThan(create);
    expect(create).toBeLessThan(personList);
    expect(newPersonSource).toContain('Neue Person erfassen');
    expect(newPersonSource).toContain('Gesetzliche Vertretung');
    expect(newPersonSource).toContain('Wirtschaftlich berechtigt');
    expect(pageSource).not.toContain('Wirtschaftlich Berechtigte:n hinzufügen');
    expect(personRolesSource).toContain('Zugeordnete Rollen');
    expect(personRolesSource).toContain('<Pencil className="h-3.5 w-3.5" /> Bearbeiten');
    expect(personRolesSource).toContain('defaultOpen');
    expect(beneficialOwnerSource).toContain('Anteil (%)');
    expect(personRolesSource).toContain('<AddBeneficialOwnerRoleForm');
    expect(addOwnerRoleSource).toContain('Doppelrolle speichern');
    expect(addOwnerRoleSource).toContain('Anteil (%)');
    expect(personRolesSource).toContain('können hier nicht frei eingegeben werden');
    expect(legalEntityDetailsSource).not.toContain(
      'Mitglieder des Vertretungsorgans / gesetzliche Vertreter',
    );
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001, GWG-REPRESENTATIVE-AUTHORITY-001
  it('zeigt einen Owner-Ausweis bei einer verknüpften Doppelrolle unter der gemeinsamen Person', () => {
    expect(pageSource).toContain('displaySubjectKeyForAssignment(');
    expect(pageSource).not.toContain('const persistedSubjectKey = subjectKeyForAssignment(');
  });

  // Fachkatalog: GWG-BENEFICIAL-OWNERS-001, GWG-REPRESENTATIVE-AUTHORITY-001
  it('trennt allgemeine Personenangaben von rollenspezifischen Angaben', () => {
    const general = pageSource.indexOf('<PersonGeneralForm');
    const identity = pageSource.indexOf('<IdentityDocumentReview', general);
    const roles = pageSource.indexOf('<PersonRolesPanel', general);

    expect(general).toBeGreaterThan(-1);
    expect(general).toBeLessThan(identity);
    expect(identity).toBeLessThan(roles);
    expect(personGeneralSource).toContain('Allgemeine Angaben');
    expect(personGeneralSource).toContain('<ContactRound');
    expect(personRolesSource).toContain('<BadgeCheck');
    expect(personGeneralSource).toContain(
      'Änderungen gelten für die Person in allen zugeordneten Rollen.',
    );
    expect(newPersonSource).toContain('Allgemeine Angaben');
    expect(newPersonSource.indexOf('Allgemeine Angaben')).toBeLessThan(
      newPersonSource.indexOf('Rolle(n)'),
    );
    expect(addOwnerRoleSource).not.toContain('name="birthDate"');
    expect(addOwnerRoleSource).not.toContain('name="isPep"');
    expect(beneficialOwnerSource).not.toContain('<label className="label-sm">Geburtsdatum');
    expect(beneficialOwnerSource).toContain('name="ownershipPct"');
  });

  it('stellt die Anteilsangabe der Doppelrolle mit semantischen Dark-Mode-Flächen dar', () => {
    expect(addOwnerRoleSource).toContain('bg-surface-raised');
    expect(addOwnerRoleSource).toContain('border-default bg-surface p-3');
    expect(addOwnerRoleSource).toContain('text-secondary');
    expect(addOwnerRoleSource).toContain('<BadgePercent');
    expect(addOwnerRoleSource).not.toContain('bg-brand-50/30');
  });
});
