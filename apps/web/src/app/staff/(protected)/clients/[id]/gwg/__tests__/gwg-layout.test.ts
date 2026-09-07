import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const identityReviewSource = readFileSync(
  new URL('../identity-document-review.tsx', import.meta.url),
  'utf8',
);
const selectCurrentButtonSource = readFileSync(
  new URL('../select-current-identity-set-button.tsx', import.meta.url),
  'utf8',
);
const addOwnerRoleSource = readFileSync(
  new URL('../add-beneficial-owner-role-form.tsx', import.meta.url),
  'utf8',
);

// Page structure is covered by real SSR in page-render.test.tsx.
describe('GwG interaktive Komponentenverträge', () => {
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
    expect(identityReviewSource).toContain('const canConfirmDirectly = canConfirmIdentityReview(');
    expect(identityReviewSource).toContain('!input.hasCompetingActiveSets');
  });

  // Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
  it('lässt bei einem Doppelbestand bewusst genau einen aktuellen Ausweissatz auswählen', () => {
    expect(identityReviewSource).toContain('hasCompetingActiveSets={groups.length > 1}');
    expect(selectCurrentButtonSource).toContain('Diesen Ausweis als aktuell festlegen');
    expect(selectCurrentButtonSource).toContain('unter „Alte Ausweise“ abgelegt');
  });

  it('stellt die Anteilsangabe der Doppelrolle mit semantischen Dark-Mode-Flächen dar', () => {
    expect(addOwnerRoleSource).toContain('bg-surface-raised');
    expect(addOwnerRoleSource).toContain('border-default bg-surface p-3');
    expect(addOwnerRoleSource).toContain('text-secondary');
    expect(addOwnerRoleSource).toContain('<BadgePercent');
    expect(addOwnerRoleSource).not.toContain('bg-brand-50/30');
  });
});
