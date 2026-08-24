import { describe, expect, it } from 'vitest';

// Fachkatalog: GWG-IDENTIFICATION-EVIDENCE-001
// Fachkatalog: GWG-BENEFICIAL-OWNERS-001
import {
  gwgDecisionGateErrors,
  gwgVerificationErrors,
  type GwgDecisionGateSnapshot,
  type GwgVerificationSnapshot,
  type VerificationDocument,
} from '../verification';

const NOW = new Date('2026-07-11T14:00:00Z');
const CHECK_ID = 'check-1';
const CLIENT_ID = 'client-1';
const REPRESENTATIVE_ID = 'representative-1';

function evidence(
  type: string,
  overrides: Partial<VerificationDocument> = {},
): VerificationDocument {
  const personal = type === 'PERSONALAUSWEIS' || type === 'REISEPASS';
  return {
    gwgCheckId: CHECK_ID,
    documentSetId: `set-${type}`,
    type,
    ownerName: personal ? 'Erika Muster' : 'Muster GmbH',
    number: personal ? 'L01X00T47' : null,
    issuedBy: personal ? 'Stadt Berlin' : null,
    issueDate: personal ? new Date('2020-01-01T00:00:00Z') : null,
    expiryDate: personal ? new Date('2027-01-01T00:00:00Z') : null,
    verifiedAt: personal ? NOW : null,
    naturalClientSubjectId: null,
    beneficialOwnerSubjectId: null,
    representativeSubjectId: personal ? REPRESENTATIVE_ID : null,
    identityAssignmentConfirmedAt: personal ? NOW : null,
    identityAssignmentConfirmedBy: personal ? 'staff-1' : null,
    documentId: `doc-${type}`,
    document: {
      clientId: CLIENT_ID,
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
      gwgDestructionRequestedAt: null,
      gwgDestroyedAt: null,
      versions: [{ scanStatus: 'CLEAN', scanCompletedAt: NOW }],
    },
    ...overrides,
  };
}

function legalSnapshot(overrides: Partial<GwgVerificationSnapshot> = {}): GwgVerificationSnapshot {
  return {
    checkId: CHECK_ID,
    clientId: CLIENT_ID,
    clientKind: 'JURPERS',
    legalForm: 'GmbH',
    registerNumber: 'HRB 12345',
    registerAuthority: 'Amtsgericht Berlin-Charlottenburg',
    noRegisterEntry: false,
    representativeNames: ['Erika Muster'],
    representatives: [
      {
        id: REPRESENTATIVE_ID,
        gwgCheckId: CHECK_ID,
        fullName: 'Erika Muster',
        position: 0,
      },
    ],
    ownershipStructureNotes: 'Erika Muster haelt 100 % der Geschaeftsanteile.',
    beneficialOwners: [
      {
        fullName: 'Erika Muster',
        birthDate: new Date('1980-01-02T00:00:00Z'),
        birthPlace: 'Berlin',
        residence: 'Musterstrasse 1, 10115 Berlin',
        nationality: 'deutsch',
        isPep: false,
      },
    ],
    idDocuments: [
      evidence('PERSONALAUSWEIS'),
      evidence('HANDELSREGISTERAUSZUG'),
      evidence('TRANSPARENZREGISTER_AUSZUG'),
    ],
    ...overrides,
  };
}

describe('gwgVerificationErrors', () => {
  it('akzeptiert einen vollstaendigen Rechtstraeger-Snapshot mit bestaetigter Vertreter-UUID', () => {
    expect(gwgVerificationErrors(legalSnapshot(), NOW)).toEqual([]);
  });

  it('akzeptiert eine nicht registerpflichtige GbR mit Gesellschaftsvertrag', () => {
    expect(
      gwgVerificationErrors(
        legalSnapshot({
          clientKind: 'PERSGES',
          legalForm: 'GbR',
          registerNumber: null,
          registerAuthority: null,
          noRegisterEntry: true,
          idDocuments: [evidence('PERSONALAUSWEIS'), evidence('GESELLSCHAFTSVERTRAG')],
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('verlangt Register-, Vertretungs-, Struktur- und Dokumentangaben', () => {
    const errors = gwgVerificationErrors(
      legalSnapshot({
        legalForm: null,
        registerNumber: null,
        registerAuthority: null,
        representativeNames: [],
        representatives: [],
        ownershipStructureNotes: null,
        beneficialOwners: [],
        idDocuments: [],
      }),
      NOW,
    );
    expect(errors.length).toBeGreaterThanOrEqual(8);
  });

  it('wertet fremde, geloeschte, pending oder falsch klassifizierte Dateien nicht als Nachweis', () => {
    const invalid = legalSnapshot({
      idDocuments: [
        evidence('PERSONALAUSWEIS', {
          document: {
            clientId: 'client-2',
            classification: 'GWG_EVIDENCE',
            deletedAt: null,
            gwgDestructionRequestedAt: null,
            gwgDestroyedAt: null,
            versions: [{ scanStatus: 'CLEAN', scanCompletedAt: NOW }],
          },
        }),
        evidence('HANDELSREGISTERAUSZUG', {
          document: {
            clientId: CLIENT_ID,
            classification: 'GENERAL',
            deletedAt: null,
            gwgDestructionRequestedAt: null,
            gwgDestroyedAt: null,
            versions: [{ scanStatus: 'CLEAN', scanCompletedAt: NOW }],
          },
        }),
        evidence('TRANSPARENZREGISTER_AUSZUG', {
          document: {
            clientId: CLIENT_ID,
            classification: 'GWG_EVIDENCE',
            deletedAt: null,
            gwgDestructionRequestedAt: NOW,
            gwgDestroyedAt: null,
            versions: [{ scanStatus: 'CLEAN', scanCompletedAt: NOW }],
          },
        }),
      ],
    });
    expect(gwgVerificationErrors(invalid, NOW)).toHaveLength(3);
  });

  it('akzeptiert bei NATPERS nur den exakt zugeordneten Mandanten bis einschliesslich Ablaufdatum', () => {
    const valid = evidence('PERSONALAUSWEIS', {
      naturalClientSubjectId: CLIENT_ID,
      representativeSubjectId: null,
      expiryDate: new Date('2026-07-11T00:00:00Z'),
    });
    expect(
      gwgVerificationErrors(legalSnapshot({ clientKind: 'NATPERS', idDocuments: [valid] }), NOW),
    ).toEqual([]);

    const wrongOwner = {
      ...valid,
      naturalClientSubjectId: null,
      beneficialOwnerSubjectId: 'owner-1',
    };
    expect(
      gwgVerificationErrors(
        legalSnapshot({ clientKind: 'NATPERS', idDocuments: [wrongOwner] }),
        NOW,
      ),
    ).toHaveLength(1);
  });

  it('akzeptiert einen gleichnamigen UBO nicht als Vertreter', () => {
    const uboOnly = evidence('PERSONALAUSWEIS', {
      representativeSubjectId: null,
      beneficialOwnerSubjectId: 'owner-1',
    });
    const errors = gwgVerificationErrors(
      legalSnapshot({
        idDocuments: [
          uboOnly,
          evidence('HANDELSREGISTERAUSZUG'),
          evidence('TRANSPARENZREGISTER_AUSZUG'),
        ],
      }),
      NOW,
    );
    expect(errors.some((error) => error.includes('vertretungsberechtigte Person'))).toBe(true);
  });

  it('verlangt verifiedAt und die explizite Bestaetigung gleichzeitig', () => {
    const missingConfirmation = evidence('PERSONALAUSWEIS', {
      identityAssignmentConfirmedAt: null,
      identityAssignmentConfirmedBy: null,
    });
    const missingVerification = evidence('PERSONALAUSWEIS', { verifiedAt: null });
    for (const document of [missingConfirmation, missingVerification]) {
      const errors = gwgVerificationErrors(
        legalSnapshot({
          idDocuments: [
            document,
            evidence('HANDELSREGISTERAUSZUG'),
            evidence('TRANSPARENZREGISTER_AUSZUG'),
          ],
        }),
        NOW,
      );
      expect(errors.some((error) => error.includes('vertretungsberechtigte Person'))).toBe(true);
    }
  });

  it('wertet keine Metadatenhuelle und keine noch ungepruefte neueste Dateiversion als Nachweis', () => {
    for (const versions of [
      [],
      [{ scanStatus: 'CLEAN', scanCompletedAt: null }],
      [{ scanStatus: 'PENDING', scanCompletedAt: null }],
      [{ scanStatus: 'INFECTED', scanCompletedAt: NOW }],
    ]) {
      const personal = evidence('PERSONALAUSWEIS', {
        document: {
          clientId: CLIENT_ID,
          classification: 'GWG_EVIDENCE',
          deletedAt: null,
          gwgDestructionRequestedAt: null,
          gwgDestroyedAt: null,
          versions,
        },
      });
      const errors = gwgVerificationErrors(
        legalSnapshot({
          idDocuments: [
            personal,
            evidence('HANDELSREGISTERAUSZUG'),
            evidence('TRANSPARENZREGISTER_AUSZUG'),
          ],
        }),
        NOW,
      );
      expect(errors.some((error) => error.includes('vertretungsberechtigte Person'))).toBe(true);
    }
  });

  it('blockiert inkonsistente Metadaten innerhalb derselben Dokumentgruppe', () => {
    const front = evidence('PERSONALAUSWEIS', { documentId: 'front' });
    const back = evidence('PERSONALAUSWEIS', {
      documentId: 'back',
      number: 'ANDERE-NUMMER',
    });
    const errors = gwgVerificationErrors(
      legalSnapshot({
        idDocuments: [
          front,
          back,
          evidence('HANDELSREGISTERAUSZUG'),
          evidence('TRANSPARENZREGISTER_AUSZUG'),
        ],
      }),
      NOW,
    );
    expect(errors.some((error) => error.includes('vertretungsberechtigte Person'))).toBe(true);
  });
});

describe('gwgDecisionGateErrors', () => {
  function decisionSnapshot(
    overrides: Partial<GwgDecisionGateSnapshot> = {},
  ): GwgDecisionGateSnapshot {
    return {
      ...legalSnapshot(),
      riskScore: 4,
      riskLevel: 'MEDIUM',
      riskAnswers: { country: 1, pep: 0 },
      ...overrides,
    };
  }

  it('uses one complete rule chain for submission and approval', () => {
    expect(gwgDecisionGateErrors(decisionSnapshot(), ['country', 'pep'], NOW)).toEqual([]);
  });

  it('treats null and absent risk-factor answers as incomplete', () => {
    const errors = gwgDecisionGateErrors(
      decisionSnapshot({ riskAnswers: { country: null } }),
      ['country', 'pep'],
      NOW,
    );
    expect(errors.some((error) => error.includes('Risikoanalyse ist unvollständig'))).toBe(true);
  });

  it('requires both the explicit PEP factor and HIGH risk for a PEP owner', () => {
    const snapshot = decisionSnapshot({
      beneficialOwners: legalSnapshot().beneficialOwners.map((owner) => ({
        ...owner,
        isPep: true,
      })),
      riskAnswers: { country: 1, pep: 0 },
      riskLevel: 'MEDIUM',
    });
    const errors = gwgDecisionGateErrors(snapshot, ['country', 'pep'], NOW);
    expect(errors.some((error) => error.includes('PEP-Risikofaktor'))).toBe(true);
    expect(errors.some((error) => error.includes('muss HIGH ergeben'))).toBe(true);
  });
});
