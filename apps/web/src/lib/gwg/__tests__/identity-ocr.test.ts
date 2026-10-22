import { describe, expect, it } from 'vitest';
// Fachkatalog: GWG-OCR-ASSIST-001, GWG-IDENTIFICATION-EVIDENCE-001
import {
  compareWithMrz,
  detectedSide,
  mrzCheckDigit,
  parseGermanIdentityText,
} from '../identity-ocr';
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
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'mrz-date-century',
          field: 'birthDate',
          text: expect.stringContaining('Jahrhundert'),
        }),
      ]),
    );
  });
  it('gives a manual fallback for illegible input', () => {
    expect(parseGermanIdentityText('???')).toEqual({
      fields: {},
      warnings: [
        {
          code: 'nothing-found',
          text: 'Keine sicheren Feldvorschläge erkannt. Bitte manuell erfassen.',
        },
      ],
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
        expect.objectContaining({
          code: 'date-conflict',
          field: 'birthDate',
          text: expect.stringContaining('Geburtsdatum: Sichttext'),
        }),
        expect.objectContaining({
          code: 'date-conflict',
          field: 'idExpiryDate',
          text: expect.stringContaining('Gültig bis: Sichttext'),
        }),
      ]),
    );
    const matching = parseGermanIdentityText(
      `Geburtsdatum: 12.08.1864\nGültig bis: 31.12.2130\n${first}\n${second}`,
    );
    expect(matching.fields).toMatchObject({ birthDate: '1864-08-12', idExpiryDate: '2130-12-31' });
    expect(matching.warnings).toEqual([]);
  });
});

// Echte Tesseract-Ausgaben (deu+eng, LSTM) des veröffentlichten Musterausweises
// „Erika Mustermann“ mit der Aufbereitung der Ausweishilfe (Browser-Canvas,
// Graustufen, Kontraststreckung, ~2000 px). Der Stempel „MUSTER“ überdeckt dort
// Geburtsdatum, -ort und Teile der Anschrift; ein echter Ausweis hat ihn nicht.
const SPECIMEN_FRONT = `Dee 7683118087
PERSONALAUSWEIS wow LL

IDENTITY CARD / CARTE D'IDENTITE |

[a] Name/Surname/Nom
[b] Geburtsname/Name at birth/Nom de naissance %

[a3] MUSTERMANN

IGABLER
Vornamen/Given names/Prénoms

ERIKA x
BER of / NONE
12 EN EUTSCH

Gebu of /Lieu de naissance

BE

Gültig bis/Date of expiry/

| 01.05.2034 SZ

AA`;
const SPECIMEN_BACK = `A Augenfarbe/Colour of eyes/Couleur des yeux Anschrift/Address/Adresse

GRUN 51147 KOLN

GroBe/Height/Taille

160 cm jm HE IDESTRASSE \\ &
Datum/Date/Date (0) 1 If) a 1 i A A
02.05.24 if £3 WS »
Behdrde/Authority/Autorité ET Hi kn De Fi Doctoral degree/Grade bos cig
STADT KOLN

snr name/Nom de religion ou nom d'artiste (
LZ63117475<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<

IDD<<LZ6311T475<<<<<<LLLL<LL<L<L<<
8308126<3405019D<<2405<<<<<<<3
MUSTERMANN<<ERIKA<S<<<S<<<<S<<<<<`;
// Dieselbe Vorderseite ohne Kontraststreckung: Ausweisnummer mit T als 7 gelesen.
const SPECIMEN_FRONT_T_AS_7 = `FEDERAL REPUBLIC OF GERMANY / REPUBLIQUE FEDERALE D’ALLEMAGNE

BUNDESREPUBLIK DEUTSCHLAND LZ6311747 X

PERSONALAUSWEIS

IDENTITY CARD / CARTE D'IDENTITE

[a] Name/Surname/Nom
[b] Geburtsname/Name at birth/Nom de naissance

aIMUSTERMANN «Co
BIGABLER
Vornamen/Given names/Prenoms N

ERIKA

Geburtstag/Date of / angehörigkeit/Nationality/
Date de naissa alite ;
| 12, oo: EUTSCH
Gebu of /Lieu de naissance >
BE

Gültig bis/Date of expiry/

| 01.05.2034 938568`;

describe('GWG-OCR-ASSIST-001 aktueller Personalausweis (Muster des Bundes)', () => {
  it('Vorderseite: Name trotz Markern und Störzeichen, Ablaufdatum über der französischen Zeile', () => {
    const result = parseGermanIdentityText(SPECIMEN_FRONT);
    expect(result.fields).toEqual({ fullName: 'ERIKA MUSTERMANN', idExpiryDate: '2034-05-01' });
    expect(result.mrz).toBeUndefined();
    expect(parseGermanIdentityText(SPECIMEN_FRONT_T_AS_7).fields).toEqual({
      fullName: 'ERIKA MUSTERMANN',
      idExpiryDate: '2034-05-01',
      // Sichttext ohne Prüfziffer; der Abgleich mit der Rückseite warnt.
      idNumber: 'LZ6311747',
    });
  });

  it('Rückseite: Behörde, PLZ/Ort, prüfziffergesicherte Nummer, Staatsangehörigkeit, Name aus der MRZ', () => {
    const result = parseGermanIdentityText(SPECIMEN_BACK);
    expect(result.fields).toEqual({
      idIssuedBy: 'STADT KOLN',
      postalCode: '51147',
      city: 'KOLN',
      idNumber: 'LZ6311T47',
      nationality: 'DEUTSCH',
      fullName: 'ERIKA MUSTERMANN',
    });
    expect(result.mrz).toEqual({
      documentNumber: 'LZ6311T47',
      birthDate: '830812',
      expiryDate: '340501',
    });
    // Kein geratenes Jahrhundert – weder aus der MRZ noch aus „02.05.24“.
    expect(result.fields.birthDate).toBeUndefined();
    expect(result.fields.idIssueDate).toBeUndefined();
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'issue-date-short-year',
      'mrz-date-century',
      'mrz-date-century',
      'mrz-name',
    ]);
    expect(result.warnings.map((warning) => warning.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('zweistelliger Jahreszahl'),
        expect.stringContaining('Jahrhundert in MRZ fehlt'),
        expect.stringContaining('Name aus maschinenlesbarer Zeile'),
      ]),
    );
  });

  it('warnt beim Abgleich der Seiten über die gesicherte MRZ, ohne Werte zu ersetzen', () => {
    const front = parseGermanIdentityText(SPECIMEN_FRONT_T_AS_7).fields;
    const back = parseGermanIdentityText(SPECIMEN_BACK).mrz!;
    expect(compareWithMrz(front, back)).toEqual([
      {
        code: 'number-conflict',
        field: 'idNumber',
        text: expect.stringContaining('Ausweisnummer: LZ6311747 widerspricht'),
      },
    ]);
    expect(compareWithMrz({ ...front, idExpiryDate: '2034-05-07' }, back)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'date-conflict', field: 'idExpiryDate' }),
      ]),
    );
    expect(
      compareWithMrz(
        { birthDate: '1983-08-12', idExpiryDate: '2034-05-01', idNumber: 'LZ6311T47' },
        back,
      ),
    ).toEqual([]);
  });

  it('liest Geburtstag und Staatsangehörigkeit aus der zweispaltigen Zeile', () => {
    const result = parseGermanIdentityText(
      'Geburtstag/Date of birth/ Staatsangehörigkeit/Nationality/\nDate de naissance Nationalité\n12.08.1983 DEUTSCH\nGeburtsort/Place of birth/Lieu de naissance\nBERLIN',
    );
    expect(result.fields).toMatchObject({
      birthDate: '1983-08-12',
      nationality: 'DEUTSCH',
      birthPlace: 'BERLIN',
    });
    // Abgeschnittene Angaben sind keine Staatsangehörigkeit.
    expect(
      parseGermanIdentityText('Staatsangehörigkeit/Nationality\nEUTSCH').fields.nationality,
    ).toBeUndefined();
  });

  it('entfernt Störzeichen am Rand und hält Werte in Versalien von Beschriftungen getrennt', () => {
    expect(
      parseGermanIdentityText('Anschrift/Address/Adresse\n51147 KÖLN f\nHEIDESTRASSE 17-').fields,
    ).toEqual({ postalCode: '51147', city: 'KÖLN', street: 'HEIDESTRASSE 17' });
    expect(
      parseGermanIdentityText('Name/Surname/Nom\nNOMURA\nVornamen/Given names/Prénoms\nAKI').fields
        .fullName,
    ).toBe('AKI NOMURA');
    // Füllzeichen, als Buchstaben gelesen, sind keine Ausweisnummer.
    expect(parseGermanIdentityText('LKLKKLKLK').fields.idNumber).toBeUndefined();
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

describe('GWG-OCR-ASSIST-001 Ausweisseite aus dem Inhalt', () => {
  it('erkennt die Rückseite an Zeichenreihen oder Anschrift, die Vorderseite an Geburtsangaben', () => {
    expect(detectedSide({ fields: {}, mrz: { documentNumber: 'X' } })).toBe('back');
    expect(detectedSide({ fields: { postalCode: '51147', city: 'KOLN' } })).toBe('back');
    expect(detectedSide({ fields: { birthDate: '1983-08-12', idExpiryDate: '2034-05-01' } })).toBe(
      'front',
    );
    // Gemischt oder leer: keine Aussage, kein Hinweis.
    expect(detectedSide({ fields: { city: 'KOLN', birthPlace: 'BERLIN' } })).toBeNull();
    expect(detectedSide({ fields: { fullName: 'ERIKA MUSTERMANN' } })).toBeNull();
  });
});
