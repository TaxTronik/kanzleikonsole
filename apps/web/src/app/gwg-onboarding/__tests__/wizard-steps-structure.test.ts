import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const wizard = readFileSync(new URL('../wizard.tsx', import.meta.url), 'utf8');
const steps = readFileSync(new URL('../wizard-steps.tsx', import.meta.url), 'utf8');

describe('GwG-Onboarding – Step-Komponentenstruktur', () => {
  it('hält den Wizard als Orchestrator und rendert fünf ausgelagerte Schritte', () => {
    for (const component of [
      'MasterDataStep',
      'OwnersStep',
      'DocumentsStep',
      'PrivacyStep',
      'SubmitStep',
    ]) {
      expect(wizard).toContain(`<${component}`);
      expect(steps).toContain(`export function ${component}`);
    }

    expect(wizard).toContain('<WizardStepper step={step} />');
    expect(wizard).toContain('<WizardNavigation step={step} onPrevious={prev} onNext={next} />');
    expect(wizard).not.toContain('function OwnerCard');
    expect(wizard).not.toContain('function RepresentativeCard');
    expect(wizard).not.toContain('function IdUploadField');
    expect(wizard.split('\n').length).toBeLessThan(650);
  });

  it('reicht die generische Identity-Upload-Orchestrierung unverändert an beide Rollen durch', () => {
    expect(wizard).toContain(
      'async function handleIdentityUpload<T extends IdentityUploadSubject>',
    );
    expect(wizard).toContain('handleIdentityUpload(ownerId, side, file, personName, setOwners)');
    expect(wizard).toContain(
      'handleIdentityUpload(representativeId, side, file, personName, setRepresentatives)',
    );
    expect(wizard).toContain("uploadOnboardingFile(token, file, 'ID_DOCUMENT', personName)");
    expect(steps).toContain(
      'onOwnerUpload: (ownerId: string, side: IdentitySide, file: File) => void',
    );
    expect(steps).toContain(
      'onRepresentativeUpload: (representativeId: string, side: IdentitySide, file: File) => void',
    );
  });

  it('bewahrt gekoppelte Register- und Dateiinput-Semantik in den zustandsarmen Steps', () => {
    const registerUpdate = steps.indexOf('onRegisterStatusChange(withoutRegister)');
    const typeUpdate = steps.indexOf(
      "if (withoutRegister) onExtraTypeChange('GESELLSCHAFTSVERTRAG')",
    );
    expect(registerUpdate).toBeGreaterThanOrEqual(0);
    expect(typeUpdate).toBeGreaterThan(registerUpdate);

    const upload = steps.indexOf('if (file) onUpload(file, extraType)');
    const clearInput = steps.indexOf("event.target.value = '';", upload);
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(clearInput).toBeGreaterThan(upload);
  });
});
