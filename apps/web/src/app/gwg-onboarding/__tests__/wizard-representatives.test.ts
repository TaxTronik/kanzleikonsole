import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wizard = readFileSync(new URL('../wizard.tsx', import.meta.url), 'utf8');
const wizardSteps = readFileSync(new URL('../wizard-steps.tsx', import.meta.url), 'utf8');
const wizardValidation = readFileSync(
  new URL('../../../server/gwg-onboarding/wizard-validation.ts', import.meta.url),
  'utf8',
);

describe('GwG-Onboarding – explizite Doppelrollen-UX', () => {
  it('startet neutral und blockiert Weiter ohne bewusste Rollenentscheidung', () => {
    expect(wizard).toContain('linkedOwnerId: undefined');
    expect(wizardSteps).toContain('— bitte ausdrücklich auswählen —');
    expect(wizardSteps).toContain('representative.linkedOwnerId === undefined');
    expect(wizardValidation).toContain('Bitte entscheiden Sie ausdrücklich');
  });

  it('übermittelt stabile lokale IDs und entweder Owner-Link oder eigenen Ausweis', () => {
    expect(wizard).toContain('linkedOwnerLocalId: representative.linkedOwnerId ?? null');
    expect(wizard).toContain('idFrontDocumentId: representative.idFront?.documentId ?? null');
    expect(wizardSteps).toContain('Ja – {owner.fullName');
    expect(wizardSteps).toContain('Nein – eigenständige Person erfassen');
  });
});
