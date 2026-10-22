import { describe, expect, it } from 'vitest';
// Fachkatalog: GWG-OCR-ASSIST-001
import { naturalCase, sameIdentityValue, suggestionRows } from '../identity-suggestions';

describe('GWG-OCR-ASSIST-001 Schreibweise der Ausweisvorschläge', () => {
  it('bringt Großbuchstaben in übliche Schreibweise, ohne Umlaute oder ß zu ergänzen', () => {
    expect(naturalCase('fullName', 'ERIKA MUSTERMANN')).toBe('Erika Mustermann');
    expect(naturalCase('city', 'KOLN')).toBe('Koln');
    expect(naturalCase('idIssuedBy', 'STADT KÖLN')).toBe('Stadt Köln');
    expect(naturalCase('street', 'HEIDESTRASSE 17A')).toBe('Heidestrasse 17a');
    expect(naturalCase('birthPlace', 'MÜLHEIM AN DER RUHR')).toBe('Mülheim an der Ruhr');
    expect(naturalCase('city', 'BAD HOMBURG V. D. HÖHE')).toBe('Bad Homburg v. d. Höhe');
    expect(naturalCase('city', 'HALLE (SAALE)')).toBe('Halle (Saale)');
    expect(naturalCase('street', 'AN DER ALSTER 5')).toBe('An der Alster 5');
    expect(naturalCase('idIssuedBy', 'LANDRATSAMT RHEIN-NECKAR-KREIS')).toBe(
      'Landratsamt Rhein-Neckar-Kreis',
    );
    expect(naturalCase('nationality', 'DEUTSCH')).toBe('deutsch');
  });

  it('setzt in Namen nur deutsche Adelsprädikate klein', () => {
    expect(naturalCase('fullName', 'URSULA VON DER LEYEN')).toBe('Ursula von der Leyen');
    expect(naturalCase('fullName', 'KARL-THEODOR ZU GUTTENBERG')).toBe(
      'Karl-Theodor zu Guttenberg',
    );
    expect(naturalCase('fullName', "SEAN O'BRIEN")).toBe("Sean O'Brien");
    // „Van“ und „Le“ sind hier eigenständige Namensteile.
    expect(naturalCase('fullName', 'NGUYEN VAN AN')).toBe('Nguyen Van An');
    expect(naturalCase('fullName', 'THI HOA LE')).toBe('Thi Hoa Le');
  });

  it('lässt gemischte Schreibung, Nummern und Daten unverändert', () => {
    expect(naturalCase('fullName', 'Erika MUSTERMANN')).toBe('Erika MUSTERMANN');
    expect(naturalCase('idNumber', 'LZ6311T47')).toBe('LZ6311T47');
    expect(naturalCase('postalCode', '51147')).toBe('51147');
    expect(naturalCase('idExpiryDate', '2034-05-01')).toBe('2034-05-01');
  });
});

describe('GWG-OCR-ASSIST-001 Abgleich mit bisherigen Angaben', () => {
  it('erkennt Abweichungen nur in Groß-/Kleinschreibung, Leerzeichen oder verlorenen Umlauten', () => {
    expect(sameIdentityValue('fullName', 'Erika Mustermann', 'ERIKA  MUSTERMANN')).toBe(true);
    expect(sameIdentityValue('city', 'Köln', 'KOLN')).toBe(true);
    expect(sameIdentityValue('fullName', 'Jörg Müller', 'JOERG MUELLER')).toBe(true);
    expect(sameIdentityValue('street', 'Heidestraße 17', 'HEIDESTRASSE 17')).toBe(true);
    expect(sameIdentityValue('nationality', 'DE', 'DEUTSCH')).toBe(true);
    expect(sameIdentityValue('idNumber', 'lz6311t47', 'LZ6311T47')).toBe(true);
  });

  it('behandelt echte Unterschiede weiterhin als Ersatzvorschlag', () => {
    // Der Vorschlag hat den Umlaut, die bisherige Angabe nicht: Korrektur möglich.
    expect(sameIdentityValue('city', 'Koln', 'KÖLN')).toBe(false);
    // Kein freies Umschreiben: „ae“ entsteht nur aus einem vorhandenen Umlaut.
    expect(sameIdentityValue('fullName', 'Michal Weber', 'MICHAEL WEBER')).toBe(false);
    expect(sameIdentityValue('fullName', 'Vorhandener Name', 'ERIKA MUSTERMANN')).toBe(false);
    expect(sameIdentityValue('nationality', 'AT', 'DEUTSCH')).toBe(false);
    expect(sameIdentityValue('idExpiryDate', '2034-05-07', '2034-05-01')).toBe(false);
  });

  it('bietet Übereinstimmungen nicht an und zeigt angepasste Vorschläge mit Ausweisfassung', () => {
    const rows = suggestionRows(
      {
        fullName: 'ERIKA MUSTERMANN',
        nationality: 'DEUTSCH',
        city: 'KOLN',
        idNumber: 'LZ6311T47',
        idIssuedBy: 'STADT KOLN',
      },
      { fullName: 'Erika Mustermann', nationality: 'DE', city: 'Köln', idIssuedBy: 'Stadt Bonn' },
    );
    expect(rows.matching).toEqual(['fullName', 'nationality', 'city']);
    expect(rows.offered).toEqual([
      { field: 'idNumber', value: 'LZ6311T47' },
      { field: 'idIssuedBy', value: 'Stadt Koln', printed: 'STADT KOLN' },
    ]);
  });
});
