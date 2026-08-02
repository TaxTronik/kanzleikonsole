import { describe, expect, it } from 'vitest';
import { detectInlineOfficeKind } from '../document-preview-kind';

describe('document preview security boundary', () => {
  it('never renders DOCX/OOXML inline on the authenticated app origin', () => {
    expect(
      detectInlineOfficeKind(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'harmlos.docx',
      ),
    ).toBeNull();
    expect(detectInlineOfficeKind('application/zip', 'evil.docx')).toBeNull();
  });

  it('keeps the XLSX viewer available', () => {
    expect(
      detectInlineOfficeKind(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'tabelle.xlsx',
      ),
    ).toBe('xlsx');
  });

  it('waehlt den Viewer auch ohne Endung im Titel', () => {
    // Der Upload-Dialog strippt die Endung aus dem Titel; die Entscheidung
    // haengt deshalb am gespeicherten Dokumenttyp (`documentMimeType`), nicht
    // am sanitisierten Transport-Typ.
    expect(
      detectInlineOfficeKind(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Jahresvergleich-2025',
      ),
    ).toBe('xlsx');
  });

  it('gibt dem Transport-Typ keinen Viewer', () => {
    // Faellt `documentMimeType` weg (aeltere API-Antwort), bleibt es beim
    // Download-Pfad statt bei einer geratenen Vorschau.
    expect(detectInlineOfficeKind('application/octet-stream', 'Jahresvergleich-2025')).toBeNull();
  });
});
