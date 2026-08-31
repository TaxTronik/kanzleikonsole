import { describe, expect, it } from 'vitest';
// Fachkatalog: GWG-OCR-ASSIST-001, GWG-IDENTIFICATION-EVIDENCE-001
import { mrzCheckDigit, parseGermanIdentityText } from '../identity-ocr';
import {
  fullIdentityViewport,
  IdentitySourceViewsSchema,
  IdentityViewportSchema,
  distinctIdentityViews,
} from '../identity-viewport';

describe('GWG-OCR-ASSIST-001 local unverified suggestions', () => {
  it('extracts labeled data without keeping raw text or verification state', () => {
    const result = parseGermanIdentityText(
      'PERSONALAUSWEIS\nName: MUSTERMANN\nVornamen: ERIKA\nGeburtsdatum: 12.08.1964\nGeburtsort: BERLIN\nStaatsangehörigkeit: DEUTSCH\nGültig bis: 31.12.2030\nL01X00T47\nAnschrift\n10115 BERLIN\nMUSTERSTRASSE 12',
    );
    expect(result.fields).toMatchObject({
      fullName: 'ERIKA MUSTERMANN',
      birthDate: '1964-08-12',
      birthPlace: 'BERLIN',
      nationality: 'DEUTSCH',
      idExpiryDate: '2030-12-31',
      idNumber: 'L01X00T47',
      street: 'MUSTERSTRASSE 12',
      postalCode: '10115',
      city: 'BERLIN',
    });
    expect(Object.keys(result).sort()).toEqual(['fields', 'warnings']);
  });
  it('does not invent dates from invalid calendar days or two-digit years', () => {
    expect(parseGermanIdentityText('Geburtsdatum: 31.02.1980').fields.birthDate).toBeUndefined();
    const first = `IDD<<L01X00T47${mrzCheckDigit('L01X00T47')}`.padEnd(30, '<');
    const second = `640812${mrzCheckDigit('640812')}F301231${mrzCheckDigit('301231')}D`.padEnd(
      30,
      '<',
    );
    const result = parseGermanIdentityText(
      `${first}\n${second}\n${'MUSTERMANN<<ERIKA'.padEnd(30, '<')}`,
    );
    expect(result.fields.birthDate).toBeUndefined();
    expect(result.fields.idExpiryDate).toBeUndefined();
    expect(result.warnings.some((warning) => warning.includes('Jahrhundert'))).toBe(true);
  });
  it('gives a manual fallback for illegible input', () => {
    expect(parseGermanIdentityText('???')).toEqual({
      fields: {},
      warnings: ['Keine sicheren Feldvorschläge erkannt. Bitte manuell erfassen.'],
    });
  });
  it('removes complete trilingual name labels without treating the labels as a person name', () => {
    expect(
      parseGermanIdentityText('Name/Surname/Nom\nMUSTERMANN\nVornamen/Given names/Prénoms\nERIKA')
        .fields.fullName,
    ).toBe('ERIKA MUSTERMANN');
    expect(
      parseGermanIdentityText(
        'Name / Surname / Nom: MUSTERMANN\nVornamen / Given names / Prénoms: ERIKA',
      ).fields.fullName,
    ).toBe('ERIKA MUSTERMANN');
    expect(
      parseGermanIdentityText('Name/Surname/Nom\nVornamen/Given names/Prénoms\nERIKA').fields
        .fullName,
    ).toBeUndefined();
    expect(
      parseGermanIdentityText('Name/Surname/Nom\nVornamen/Given names/Prénoms').fields.fullName,
    ).toBeUndefined();
  });
  it('warns when valid MRZ date checksums conflict with the visible date, without replacing or guessing the century', () => {
    const first = `IDD<<L01X00T47${mrzCheckDigit('L01X00T47')}`.padEnd(30, '<');
    const second = `640812${mrzCheckDigit('640812')}F301231${mrzCheckDigit('301231')}D`.padEnd(
      30,
      '<',
    );
    const result = parseGermanIdentityText(
      `Geburtsdatum: 13.08.1964\nGültig bis: 30.12.2030\n${first}\n${second}`,
    );
    expect(result.fields).toMatchObject({ birthDate: '1964-08-13', idExpiryDate: '2030-12-30' });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Geburtsdatum: Sichttext'),
        expect.stringContaining('Gültig bis: Sichttext'),
      ]),
    );
    const matching = parseGermanIdentityText(
      `Geburtsdatum: 12.08.1864\nGültig bis: 31.12.2130\n${first}\n${second}`,
    );
    expect(matching.fields).toMatchObject({ birthDate: '1864-08-12', idExpiryDate: '2130-12-31' });
    expect(matching.warnings).toEqual([]);
  });
});

describe('GWG-IDENTIFICATION-EVIDENCE-001 immutable source view contract', () => {
  const version = '00000000-0000-4000-8000-000000000010';
  const front = fullIdentityViewport(version, 'front');
  it('rejects off-page, non-finite and duplicate-side locators', () => {
    for (const patch of [
      { width: 0 },
      { x: 0.5 },
      { page: 0 },
      { rotation: 45 },
      { y: Number.NaN },
    ]) {
      expect(IdentityViewportSchema.safeParse({ ...front, ...patch }).success).toBe(false);
    }
    const view = { ...front, documentId: version };
    expect(IdentitySourceViewsSchema.safeParse([view, view]).success).toBe(false);
  });
  it('requires a different area, not merely rotation, and the same immutable version', () => {
    expect(distinctIdentityViews(front, { ...front, side: 'back', rotation: 90 })).toBe(false);
    expect(distinctIdentityViews(front, { ...front, side: 'back', page: 2 })).toBe(true);
    expect(distinctIdentityViews(front, { ...front, side: 'back', height: 0.5 })).toBe(true);
    expect(
      distinctIdentityViews(front, { ...front, side: 'back', page: 2, versionId: 'other' }),
    ).toBe(false);
  });
});
