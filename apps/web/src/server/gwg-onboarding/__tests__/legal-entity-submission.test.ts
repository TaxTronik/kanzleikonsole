import { describe, expect, it } from 'vitest';
import { legalEntityEvidenceError } from '../legal-entity-submission';

describe('öffentliche Rechtsträgernachweise', () => {
  it('akzeptiert die erklärte nicht registerpflichtige GbR mit Gesellschaftsvertrag', () => {
    expect(
      legalEntityEvidenceError(
        'PERSGES',
        { noRegisterEntry: true },
        new Set(['GESELLSCHAFTSVERTRAG']),
      ),
    ).toBeNull();
  });

  it('verlangt KEINEN Transparenzregister-Auszug (kostenpflichtig — holt die Kanzlei)', () => {
    expect(
      legalEntityEvidenceError(
        'PERSGES',
        { noRegisterEntry: false },
        new Set(['HANDELSREGISTERAUSZUG']),
      ),
    ).toBeNull();
  });

  it('akzeptiert eine bloße Registerbefreiungs-Erklärung nicht ohne Gründungsnachweis', () => {
    expect(legalEntityEvidenceError('PERSGES', { noRegisterEntry: true }, new Set())).toContain(
      'Gesellschaftsvertrag',
    );
  });
});
