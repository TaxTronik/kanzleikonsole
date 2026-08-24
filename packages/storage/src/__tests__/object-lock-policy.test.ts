// Fachkatalog: DOC-OBJECT-LOCK-001
import { describe, expect, it } from 'vitest';
import { evaluateObjectLockConfiguration } from '../object-lock-policy';

describe('Object-Lock deployment policy', () => {
  it('akzeptiert nur den exakt erwarteten Modus und Zeitraum', () => {
    expect(
      evaluateObjectLockConfiguration(
        {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Years: 5 } },
        },
        { mode: 'GOVERNANCE', years: 5 },
      ),
    ).toEqual({ ok: true, detail: 'Enabled (Default GOVERNANCE/5 Jahre)' });
  });

  it('blockiert den früheren GwG-COMPLIANCE-Default', () => {
    const result = evaluateObjectLockConfiguration(
      {
        ObjectLockEnabled: 'Enabled',
        Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Years: 5 } },
      },
      { mode: 'GOVERNANCE', years: 5 },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('erwartet GOVERNANCE/5 Jahre');
  });

  it('blockiert fehlenden Object-Lock und falsche Laufzeiten', () => {
    expect(evaluateObjectLockConfiguration(undefined, { mode: 'COMPLIANCE', years: 10 }).ok).toBe(
      false,
    );
    expect(
      evaluateObjectLockConfiguration(
        {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Years: 8 } },
        },
        { mode: 'COMPLIANCE', years: 10 },
      ).ok,
    ).toBe(false);
  });
});
