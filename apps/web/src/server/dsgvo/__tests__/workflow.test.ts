import { describe, expect, it } from 'vitest';
import { validateDsgvoStatusEvidence, type DsgvoStatusEvidence } from '../workflow';

function input(overrides: Partial<DsgvoStatusEvidence> = {}): DsgvoStatusEvidence {
  return {
    from: 'IN_PROGRESS',
    to: 'COMPLETED',
    type: 'ACCESS',
    notes: 'Auskunft geprüft und vollständig zusammengestellt.',
    responseSentAt: new Date('2026-07-10T00:00:00.000Z'),
    responseMethod: 'Mandantenportal',
    rejectionReason: '',
    rejectionNoticeComplete: false,
    hasResultArtifact: true,
    resultReviewed: true,
    resultReviewedOn: new Date('2026-07-09T00:00:00.000Z'),
    ...overrides,
  };
}

describe('DSGVO-Statusnachweis', () => {
  it('sperrt Auskunftsabschluss ohne Ergebnisartefakt', () => {
    expect(validateDsgvoStatusEvidence(input({ hasResultArtifact: false }))).toContain('Ergebnis');
  });

  it('sperrt Auskunftsabschluss ohne personelle Vollständigkeitsprüfung', () => {
    expect(validateDsgvoStatusEvidence(input({ resultReviewed: false }))).toContain(
      'Vollständigkeit',
    );
  });

  it('sperrt jeden Abschluss ohne Versandnachweis und Maßnahmen', () => {
    expect(validateDsgvoStatusEvidence(input({ responseSentAt: null }))).toContain('Versandtag');
    expect(validateDsgvoStatusEvidence(input({ notes: 'kurz' }))).toContain('Maßnahmen');
  });

  it('sperrt einen Versandtag vor der dokumentierten Ergebnisprüfung', () => {
    expect(
      validateDsgvoStatusEvidence(
        input({
          responseSentAt: new Date('2026-07-08T00:00:00.000Z'),
        }),
      ),
    ).toContain('nicht vor');
  });

  it('sperrt Ablehnung ohne belastbare Begründung', () => {
    expect(validateDsgvoStatusEvidence(input({ to: 'REJECTED', rejectionReason: '' }))).toContain(
      'Begründung',
    );
  });

  it('sperrt Ablehnung ohne Versandnachweis und Rechtsbehelfshinweis', () => {
    expect(
      validateDsgvoStatusEvidence(
        input({
          to: 'REJECTED',
          rejectionReason: 'Identität konnte nicht bestätigt werden.',
          responseSentAt: null,
          rejectionNoticeComplete: true,
        }),
      ),
    ).toContain('Versandtag');
    expect(
      validateDsgvoStatusEvidence(
        input({
          to: 'REJECTED',
          rejectionReason: 'Identität konnte nicht bestätigt werden.',
          rejectionNoticeComplete: false,
        }),
      ),
    ).toContain('Beschwerdemöglichkeit');
  });

  it('akzeptiert eine nachweisbar versandte, vollständige Ablehnungsmitteilung', () => {
    expect(
      validateDsgvoStatusEvidence(
        input({
          to: 'REJECTED',
          rejectionReason: 'Identität konnte nicht bestätigt werden.',
          rejectionNoticeComplete: true,
        }),
      ),
    ).toBeNull();
  });

  it('akzeptiert dokumentierten Abschluss und macht Terminalstatus final', () => {
    expect(validateDsgvoStatusEvidence(input())).toBeNull();
    expect(validateDsgvoStatusEvidence(input({ from: 'COMPLETED', to: 'IN_PROGRESS' }))).toContain(
      'nicht zulässig',
    );
  });
});
