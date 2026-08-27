import { describe, expect, it } from 'vitest';
import { isSupersededEvidence, personIdentityEvidenceStatus } from '../evidence-view-state';

// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
describe('GwG-Nachweisstatus in der Staff-Ansicht', () => {
  it('behandelt ein in einem alten Prozess noch fehlendes supersededAt-Feld als aktiv', () => {
    expect(isSupersededEvidence({})).toBe(false);
    expect(isSupersededEvidence({ supersededAt: null })).toBe(false);
    expect(isSupersededEvidence({ supersededAt: new Date('2026-08-24T00:00:00Z') })).toBe(true);
  });

  it('unterscheidet einen abgelaufenen Ausweis von einem fehlenden', () => {
    expect(
      personIdentityEvidenceStatus(
        [
          {
            documents: [
              {
                expiryDate: '2026-08-24',
                identityAssignmentConfirmedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        ],
        new Date('2026-08-25T12:00:00.000Z'),
      ),
    ).toBe('abgelaufen');
    expect(personIdentityEvidenceStatus([], new Date('2026-08-25T12:00:00.000Z'))).toBe('fehlt');
  });

  it('zeigt einen gültigen bestätigten Nachweis als bestätigt', () => {
    expect(
      personIdentityEvidenceStatus(
        [
          {
            documents: [
              {
                expiryDate: '2026-08-25',
                identityAssignmentConfirmedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        ],
        new Date('2026-08-25T12:00:00.000Z'),
      ),
    ).toBe('bestaetigt');
  });

  it('kennzeichnet mehrere aktive Ausweissätze derselben Person als Fehler', () => {
    const group = {
      documents: [
        {
          expiryDate: '2030-01-01',
          identityAssignmentConfirmedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    expect(personIdentityEvidenceStatus([group, group], new Date('2026-08-25T12:00:00.000Z'))).toBe(
      'mehrfach',
    );
  });
});
