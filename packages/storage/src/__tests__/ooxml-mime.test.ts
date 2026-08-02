// =============================================================================
// Tests fuer die OOXML-Verfeinerung der Magic-Byte-Erkennung.
//
// Magic-Bytes liefern fuer xlsx/docx/pptx nur `application/zip`. Ohne die
// Verfeinerung landet jede Tabelle ohne Inline-Vorschau und ohne Dateiendung
// beim Download.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { detectMimeFromMagicBytes, detectOoxmlMime } from '../service';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function zip(entries: Record<string, string>): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) files[name] = strToU8(content);
  return Buffer.from(zipSync(files));
}

describe('detectOoxmlMime', () => {
  it('erkennt xlsx, docx und pptx am Leitverzeichnis', () => {
    expect(detectOoxmlMime(zip({ '[Content_Types].xml': '<t/>', 'xl/workbook.xml': '<w/>' }))).toBe(
      XLSX,
    );
    expect(detectOoxmlMime(zip({ 'word/document.xml': '<d/>' }))).toBe(DOCX);
    expect(detectOoxmlMime(zip({ 'ppt/presentation.xml': '<p/>' }))).toBe(PPTX);
  });

  it('findet den Marker unabhaengig von der Eintragsreihenfolge', () => {
    // openpyxl schreibt docProps/app.xml als ersten Eintrag, Excel dagegen
    // [Content_Types].xml — der erste Eintrag taugt also nicht als Signal.
    const data = zip({
      'docProps/app.xml': '<a/>',
      'docProps/core.xml': '<c/>',
      '[Content_Types].xml': '<t/>',
      'xl/workbook.xml': '<w/>',
      'xl/worksheets/sheet1.xml': '<s/>',
    });
    expect(detectOoxmlMime(data)).toBe(XLSX);
  });

  it('laesst gewoehnliche ZIPs in Ruhe', () => {
    expect(detectOoxmlMime(zip({ 'notizen.txt': 'hallo', 'bild.png': 'x' }))).toBeNull();
  });

  it('liefert null statt zu werfen, wenn die Struktur unbrauchbar ist', () => {
    expect(detectOoxmlMime(Buffer.from('PK\x03\x04 aber kein gueltiges ZIP'))).toBeNull();
    expect(detectOoxmlMime(Buffer.alloc(0))).toBeNull();
    // Abgeschnittenes Archiv: Central Directory fehlt.
    const truncated = zip({ 'xl/workbook.xml': '<w/>' }).subarray(0, 40);
    expect(detectOoxmlMime(truncated)).toBeNull();
  });

  it('verwechselt einen Eintragsnamen im Inhalt nicht mit einem Marker', () => {
    const data = zip({ 'harmlos.txt': 'der Text enthaelt xl/workbook.xml als Zeichenkette' });
    expect(detectOoxmlMime(data)).toBeNull();
  });
});

describe('detectMimeFromMagicBytes', () => {
  it('bleibt bei application/zip — die Verfeinerung ist ein eigener Schritt', () => {
    expect(detectMimeFromMagicBytes(zip({ 'xl/workbook.xml': '<w/>' }))).toBe('application/zip');
  });

  it('erkennt die uebrigen Formate unveraendert', () => {
    expect(detectMimeFromMagicBytes(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectMimeFromMagicBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });
});
