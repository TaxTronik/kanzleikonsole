import { describe, it, expect } from 'vitest';
import { extractText, cleanup, htmlToText, UnsupportedDocumentTypeError } from '../extract-text';

describe('extractText', () => {
  it('gibt text/* normalisiert zurück (CRLF + Rand-Whitespace)', async () => {
    const out = await extractText(Buffer.from('Hallo\r\nWelt   \n'), 'text/plain');
    expect(out).toBe('Hallo\nWelt');
  });

  it('strippt geschützte Leerzeichen (U+00A0)', async () => {
    const nbsp = String.fromCharCode(0xa0);
    const out = await extractText(Buffer.from('A' + nbsp + 'B'), 'text/plain');
    expect(out).toBe('A B');
  });

  it('respektiert mime mit charset-Parameter', async () => {
    const out = await extractText(Buffer.from('x'), 'text/plain; charset=utf-8');
    expect(out).toBe('x');
  });

  it('wirft UnsupportedDocumentTypeError bei Alt-.doc', async () => {
    await expect(extractText(Buffer.from('x'), 'application/msword')).rejects.toBeInstanceOf(
      UnsupportedDocumentTypeError,
    );
  });

  it('wirft UnsupportedDocumentTypeError bei unbekanntem Typ', async () => {
    await expect(extractText(Buffer.from('x'), 'image/png')).rejects.toBeInstanceOf(
      UnsupportedDocumentTypeError,
    );
  });
});

describe('cleanup', () => {
  it('kollabiert Leerzeilen-Ketten (Seitenumbruch-Lücken) auf eine Leerzeile', () => {
    expect(cleanup('A\n\n\n\n\nB')).toBe('A\n\nB');
  });

  it('entfernt Form-Feed (Seitenumbruch) als Absatz', () => {
    expect(cleanup('A\fB')).toBe('A\n\nB');
  });

  it('entfernt reine Seitenzahl-Zeilen', () => {
    expect(cleanup('Text\n\n12\n\nWeiter\n\n- 3 -\n\nSeite 4 von 9\n\nEnde')).toBe(
      'Text\n\nWeiter\n\nEnde',
    );
  });

  it('setzt am Zeilenende getrennte Wörter wieder zusammen (klein-klein)', () => {
    expect(cleanup('Gewinn-\nausschüttung')).toBe('Gewinnausschüttung');
  });

  it('verschmilzt KEINE echten Bindestrich-Komposita am Zeilenende vor Großbuchstabe', () => {
    // "GmbH-\nGeschäftsführer" → Großbuchstabe nach Umbruch: nicht zusammenfassen.
    expect(cleanup('GmbH-\nGeschäftsführer')).toBe('GmbH-\nGeschäftsführer');
  });

  it('strippt Soft-Hyphen + Zero-Width + Mehrfach-Leerzeichen', () => {
    expect(cleanup('Be­trag​   X')).toBe('Betrag X');
  });
});

describe('htmlToText', () => {
  it('ersetzt Bilder durch [Grafik]-Platzhalter', () => {
    expect(htmlToText('<p>Vor<img src="" />Nach</p>').includes('[Grafik]')).toBe(true);
  });

  it('macht aus Absätzen/Listen/Tabellen lesbaren Text', () => {
    const html =
      '<p>Absatz eins.</p><ul><li>Punkt A</li><li>Punkt B</li></ul><table><tr><td>Zelle1</td><td>Zelle2</td></tr></table>';
    const out = cleanup(htmlToText(html));
    expect(out).toContain('Absatz eins.');
    expect(out).toContain('- Punkt A');
    expect(out).toContain('- Punkt B');
    expect(out).toContain('Zelle1');
    expect(out).toContain('Zelle2');
  });

  it('dekodiert HTML-Entities', () => {
    expect(htmlToText('<p>A &amp; B &#167; 8 &quot;X&quot;</p>')).toContain('A & B § 8 "X"');
  });
});
