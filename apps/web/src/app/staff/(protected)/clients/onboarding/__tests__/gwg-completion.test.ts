import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const onboardingRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('abgeschlossene GwG im Onboarding', () => {
  it('zeigt nach der Verifikation nur noch den nächsten Schritt an', () => {
    const source = readFileSync(resolve(onboardingRoot, '[id]', 'page.tsx'), 'utf8');

    expect(source).toContain('isGwgProfessionallyReviewed(gwgCheck)');
    expect(source).toContain("if (gwgProfessionallyReviewed) doneKeys.add('gwg')");
    expect(source).toContain('professionallyReviewed={gwgProfessionallyReviewed}');
    expect(source).toContain('professionallyReviewed ? (');
    expect(source).toContain('<SkipButton clientId={clientId} next="poa" label="Weiter" />');
    expect(source).toContain('{!professionallyReviewed && !hasVerifiedStatus && (');
  });

  it('behandelt einen unvollständigen Legacy-VERIFIED-Status fail-closed', () => {
    const source = readFileSync(resolve(onboardingRoot, '[id]', 'page.tsx'), 'utf8');

    expect(source).toContain('hasVerifiedStatus && !professionallyReviewed');
    expect(source).toContain('keinen vollständigen, dokumentierten');
    expect(source).toContain('Neuen Prüfzyklus starten');
    expect(source).not.toContain("verified={gwgCheck?.status === 'VERIFIED'}");
  });

  it('verlinkt bereits durchlaufene Wizard-Schritte ohne Abschlusszustand zu ändern', () => {
    const stepper = readFileSync(resolve(onboardingRoot, 'stepper.tsx'), 'utf8');
    const page = readFileSync(resolve(onboardingRoot, '[id]', 'page.tsx'), 'utf8');

    expect(stepper).toContain("s.key !== 'master_data'");
    expect(stepper).toContain('i < currentIndex || done || onboardingComplete');
    expect(stepper).toContain('/staff/clients/onboarding/${clientId}?step=${s.key}');
    expect(page).toContain('clientId={client.id}');
    expect(page).toContain('Zurück: {previousStep.label}');
  });
});
