import { describe, expect, it } from 'vitest';
// Fachkatalog: GWG-OCR-ASSIST-001
import { clientWarningText, IDENTITY_UI_TEXT, warningText, warningTone } from '../identity-hints';
import type { IdentityWarning, IdentityWarningCode } from '../identity-ocr';

const CODES: IdentityWarningCode[] = [
  'low-confidence',
  'issue-date-short-year',
  'date-conflict',
  'number-conflict',
  'mrz-number-invalid',
  'mrz-date-century',
  'mrz-name',
  'nothing-found',
  'side-mismatch',
];
// Fachbegriffe der Kanzleifassung, die Mandanten nicht kennen müssen.
const JARGON = /MRZ|maschinenlesbar|Prüfziffer|Sichttext|Jahrhundert|ungeprüft/i;

describe('GWG-OCR-ASSIST-001 Hinweise der Ausweishilfe je Zielgruppe', () => {
  it('hat für jeden Hinweis-Code eine eigene, verständliche Mandantenfassung', () => {
    const texts = CODES.map((code) =>
      clientWarningText({ code, text: 'Fachtext', field: 'birthDate' }),
    );
    for (const text of texts) {
      expect(text).not.toBe('Fachtext');
      expect(text).not.toMatch(JARGON);
    }
    expect(new Set(texts).size).toBe(CODES.length);
    // Feldbezug bleibt erhalten.
    expect(
      clientWarningText({ code: 'mrz-date-century', text: '', field: 'idExpiryDate' }),
    ).toMatch(/^Gültig bis:/);
  });

  it('zeigt der Kanzlei den Fachtext, beim Seitenabgleich mit Kennzeichnung', () => {
    const warning: IdentityWarning = {
      code: 'number-conflict',
      field: 'idNumber',
      text: 'Ausweisnummer: X widerspricht der maschinenlesbaren Zone (Y). Bitte am Original prüfen.',
    };
    expect(warningText(warning, 'staff')).toBe(warning.text);
    expect(warningText({ ...warning, acrossSides: true }, 'staff')).toBe(
      `Abgleich der Ausweisseiten: ${warning.text}`,
    );
    expect(warningText({ ...warning, acrossSides: true }, 'client')).not.toMatch(JARGON);
  });

  it('formuliert die festen Texte für Mandanten ohne Fachbegriffe, für die Kanzlei unverändert', () => {
    const client = IDENTITY_UI_TEXT.client;
    for (const text of [
      client.intro,
      client.missing,
      client.compare,
      client.apply,
      client.imageAlt,
      client.printed('STADT KOLN'),
      client.matching(['Ort']),
    ])
      expect(text).not.toMatch(JARGON);
    expect(client.applied(['Gültig bis'])).toMatch(
      /^1 Angabe übernommen und im Formular grün markiert/,
    );
    expect(client.applied(['Name', 'PLZ'])).toMatch(/^2 Angaben/);
    // Die E2E-Suite und die Kanzleiabläufe hängen an diesen Beschriftungen.
    expect(IDENTITY_UI_TEXT.staff.apply).toBe('Ausgewählte Daten übernehmen (ungeprüft)');
  });

  it('hebt nur Widersprüche und eine vertauschte Seite hervor', () => {
    const tone = (code: IdentityWarningCode) => warningTone({ code, text: '' });
    expect(CODES.filter((code) => tone(code) === 'attention')).toEqual([
      'date-conflict',
      'number-conflict',
      'mrz-number-invalid',
      'side-mismatch',
    ]);
    expect(clientWarningText({ code: 'side-mismatch', text: '', side: 'back' })).toMatch(
      /^Das sieht nach der Rückseite Ihres Ausweises aus\./,
    );
  });
});
