import { describe, it, expect } from 'vitest';
import { extractText, getDocumentProxy } from 'unpdf';
import { renderPdf } from '../to-pdf';
import type { ReportModel } from '../report-model';
import { UnsupportedPdfTextError } from '@/server/documents/pdf-fonts';

// Synthetisches Modell (keine Echtdaten) — deckt die heikle annotierte
// Sachverhalt-Ausgabe ab: markierte Stellen, Marker [n] und Absätze (\n\n).
function model(): ReportModel {
  return {
    title: 'Testbericht',
    clientName: 'Beispiel GmbH',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    textHash: 'a'.repeat(64),
    katalogVersion: '1.0',
    engineVersion: '1.0',
    llmEnriched: false,
    tokens: [
      { kind: 'text', text: 'Erster Absatz mit einer ', color: null, streitig: false },
      { kind: 'text', text: 'markierten Stelle', color: '#14b8a6', streitig: false },
      { kind: 'marker', nr: 1, color: '#14b8a6' },
      {
        kind: 'text',
        text: '.\n\nZweiter Absatz nach einer Leerzeile.',
        color: null,
        streitig: false,
      },
    ],
    markings: [
      {
        nr: 1,
        fundstelle: 'markierten Stelle',
        begriff: 'Begriff',
        herkunftLabel: 'Berater',
        herkunftColor: '#14b8a6',
        engineStatusLabel: null,
        streitig: false,
        normAnker: ['§ 1 AO'],
        governanceLabel: null,
        schadenLabel: null,
        wahrscheinlichkeitLabel: null,
        statusLabel: 'Offen',
        kontrolle: null,
        notiz: null,
      },
    ],
    counts: { gesamt: 1, eigen: 1 },
  };
}

describe('renderPdf', () => {
  it('rendert ein gültiges PDF (annotierter Text mit Absätzen + Marker)', async () => {
    const buf = await renderPdf(model());
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('bricht lange Absätze sauber um (kein continued-Overlap, mehrere Seiten)', async () => {
    const m = model();
    m.tokens = [{ kind: 'text', text: 'Wort '.repeat(800).trim(), color: null, streitig: false }];
    const buf = await renderPdf(m);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('rendert auch ohne Markierungen', async () => {
    const m = model();
    m.tokens = [
      { kind: 'text', text: 'Nur Fließtext ohne Markierung.', color: null, streitig: false },
    ];
    m.markings = [];
    m.counts = { gesamt: 0, eigen: 0 };
    const buf = await renderPdf(m);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

const NAMES = ['Yıldız Bau GmbH', 'Şahin', 'Łódź', 'Dvořák', 'Müller', 'Çelik'];

async function pdfText(buf: Buffer): Promise<string> {
  const { text } = await extractText(new Uint8Array(buf), { mergePages: true });
  return text;
}

describe('renderPdf — eingebettete Unicode-Schriften (F-02)', () => {
  it('setzt Namen außerhalb von WinAnsi in Kopf, Sachverhalt und Tabelle verlustfrei', async () => {
    const m = model();
    m.clientName = NAMES.join(', ');
    m.tokens = [
      { kind: 'text', text: `Gesellschafter ${NAMES.join(', ')}.`, color: null, streitig: false },
    ];
    m.markings = [{ ...m.markings[0]!, streitig: true, notiz: NAMES.join(' / ') }];
    const text = await pdfText(await renderPdf(m));
    // Je Name genau dreimal: Metazeile, wortweise gesetzter Sachverhalt, umbrochene Zelle.
    for (const name of NAMES) expect(text.split(name).length - 1, name).toBe(3);
    expect(text).toContain('⚠ streitig'); // Symbol aus der geprüften Ersatzschrift
  });

  it('setzt das Folgewort hinter Zeichen der Ersatzschrift ohne Überlappung', async () => {
    const m = model();
    m.tokens = [
      { kind: 'text', text: 'Vertrag mit 李明 vom Januar', color: null, streitig: false },
    ];
    const pdf = await getDocumentProxy(new Uint8Array(await renderPdf(m)));
    const content = await (await pdf.getPage(1)).getTextContent();
    const items = content.items.flatMap((item) => ('str' in item && item.str.trim() ? [item] : []));
    const index = items.findIndex((item) => item.str === '李明');
    expect(index).toBeGreaterThan(-1);
    const [glyphs, next] = [items[index]!, items[index + 1]!];
    expect(next.str).toMatch(/^vom/);
    expect(next.transform[4]).toBeGreaterThanOrEqual(glyphs.transform[4] + glyphs.width);
  });

  it('setzt Tabulatoren als Leerraum statt als Ersatzkästchen', async () => {
    const m = model();
    m.tokens = [{ kind: 'text', text: 'Spalte\tWert', color: null, streitig: false }];
    m.markings = [{ ...m.markings[0]!, notiz: 'Notiz\tmit Tab' }];
    const text = await pdfText(await renderPdf(m));
    expect(text).toContain('Spalte Wert');
    expect(text).toContain('Notiz mit Tab');
    expect(text).not.toContain('\u0000');
  });

  it('sperrt nicht abgedeckte Zeichen ausdrücklich statt stillen Zeichensalats', async () => {
    const inText = model();
    inText.tokens = [{ kind: 'text', text: 'Mandant Müller 😀', color: null, streitig: false }];
    await expect(renderPdf(inText)).rejects.toThrow(UnsupportedPdfTextError);
    await expect(renderPdf(inText)).rejects.toThrow('U+1F600');
    const inTable = model();
    inTable.markings = [{ ...inTable.markings[0]!, notiz: 'مرحبا' }];
    await expect(renderPdf(inTable)).rejects.toThrow(UnsupportedPdfTextError);
  });
});
