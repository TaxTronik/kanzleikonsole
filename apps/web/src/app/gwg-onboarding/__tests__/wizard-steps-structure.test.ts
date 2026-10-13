import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../actions', () => ({ loadOnboardingIdentitySourceAction: vi.fn() }));

import * as steps from '../wizard-steps';

// Architektur-Guard (bewusst Quelltext): Der Wizard bleibt Orchestrator für
// Zustand und Übermittlung, die Schrittkarten liegen in wizard-steps.tsx.
// Das Verhalten der Schritte prüft wizard-flow.test.tsx (B-08, Welle 15).
const wizard = readFileSync(new URL('../wizard.tsx', import.meta.url), 'utf8');

describe('GwG-Onboarding – Step-Komponentenstruktur', () => {
  it('hält den Wizard als Orchestrator mit fünf ausgelagerten Schritten', () => {
    for (const component of [
      'MasterDataStep',
      'OwnersStep',
      'DocumentsStep',
      'PrivacyStep',
      'SubmitStep',
      'WizardStepper',
      'WizardNavigation',
    ] as const) {
      expect(typeof steps[component]).toBe('function');
    }
    expect(wizard).not.toContain('function OwnerCard');
    expect(wizard).not.toContain('function RepresentativeCard');
    expect(wizard).not.toContain('function IdUploadField');
    expect(wizard.split('\n').length).toBeLessThan(650);
  });
});
