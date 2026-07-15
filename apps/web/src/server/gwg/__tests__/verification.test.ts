import { describe, expect, it } from 'vitest';
import {
  gwgVerificationErrors,
  type GwgVerificationSnapshot,
  type VerificationDocument,
} from '../verification';

const NOW = new Date('2026-07-11T14:00:00Z');

function evidence(
  type: string,
  ownerName = 'Erika Muster',
  overrides: Partial<VerificationDocument> = {},
): VerificationDocument {
  return {
    type,
    ownerName,
    number: type === 'PERSONALAUSWEIS' ? 'L01X00T47' : null,
    issuedBy: type === 'PERSONALAUSWEIS' ? 'Stadt Berlin' : null,
    expiryDate: type === 'PERSONALAUSWEIS' ? new Date('2027-01-01T00:00:00Z') : null,
    documentId: `doc-${type}`,
    document: {
      clientId: 'client-1',
      classification: 'GWG_EVIDENCE',
      deletedAt: null,
    },
    ...overrides,
  };
}

function legalSnapshot(overrides: Partial<GwgVerificationSnapshot> = {}): GwgVerificationSnapshot {
  return {
    clientId: 'client-1',
    clientKind: 'JURPERS',
    legalForm: 'GmbH',
    registerNumber: 'HRB 12345',
    registerAuthority: 'Amtsgericht Berlin-Charlottenburg',
    noRegisterEntry: false,
    representativeNames: ['Erika Muster'],
    ownershipStructureNotes: 'Erika Muster hält 100 % der Geschäftsanteile.',
    beneficialOwners: [
      {
        fullName: 'Erika Muster',
        birthDate: new Date('1980-01-02T00:00:00Z'),
        birthPlace: 'Berlin',
        residence: 'Musterstraße 1, 10115 Berlin',
        nationality: 'deutsch',
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
  it('akzeptiert einen vollständigen Rechtsträger-Snapshot', () => {
    expect(gwgVerificationErrors(legalSnapshot(), NOW)).toEqual([]);
  });

  it('akzeptiert eine nicht registerpflichtige GbR mit Gesellschaftsvertrag statt Transparenzregister-Auszug', () => {
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
        ownershipStructureNotes: null,
        beneficialOwners: [],
        idDocuments: [],
      }),
      NOW,
    );
    expect(errors.length).toBeGreaterThanOrEqual(8);
  });

  it('wertet fremde, gelöschte oder falsch klassifizierte Dateien nicht als Nachweis', () => {
    const invalid = legalSnapshot({
      idDocuments: [
        evidence('PERSONALAUSWEIS', 'Erika Muster', {
          document: { clientId: 'client-2', classification: 'GWG_EVIDENCE', deletedAt: null },
        }),
        evidence('HANDELSREGISTERAUSZUG', 'Erika Muster', {
          document: { clientId: 'client-1', classification: 'GENERAL', deletedAt: null },
        }),
        evidence('TRANSPARENZREGISTER_AUSZUG', 'Erika Muster', {
          document: { clientId: 'client-1', classification: 'GWG_EVIDENCE', deletedAt: NOW },
        }),
      ],
    });
    expect(gwgVerificationErrors(invalid, NOW)).toHaveLength(3);
  });

  it('akzeptiert einen Ausweis bis einschließlich seines Ablaufdatums', () => {
    const snapshot = legalSnapshot({
      clientKind: 'NATPERS',
      idDocuments: [
        evidence('PERSONALAUSWEIS', 'Erika Muster', {
          expiryDate: new Date('2026-07-11T00:00:00Z'),
        }),
      ],
    });
    expect(gwgVerificationErrors(snapshot, NOW)).toEqual([]);
  });

  it('verlangt bei juristischen Personen den Ausweis einer benannten Vertretung', () => {
    const errors = gwgVerificationErrors(
      legalSnapshot({ representativeNames: ['Max Vertreter'] }),
      NOW,
    );
    expect(errors.some((error) => error.includes('vertretungsberechtigte Person'))).toBe(true);
  });

  it('blockiert unvollständige Identifizierungsdaten wirtschaftlich Berechtigter', () => {
    const errors = gwgVerificationErrors(
      legalSnapshot({
        beneficialOwners: [
          {
            fullName: 'Erika Muster',
            birthDate: null,
            birthPlace: null,
            residence: null,
            nationality: null,
          },
        ],
      }),
      NOW,
    );

    expect(errors).toContain(
      'Wirtschaftlich Berechtigter 1: Geburtsdatum, Geburtsort, Wohnsitz, Staatsangehörigkeit fehlen (§ 11 Abs. 5 GwG).',
    );
  });
});
