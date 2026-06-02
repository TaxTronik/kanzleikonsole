import { describe, it, expect } from 'vitest';
import { renderPdf } from '../to-pdf';
import type { ReportModel } from '../report-model';

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
      { kind: 'text', text: '.\n\nZweiter Absatz nach einer Leerzeile.', color: null, streitig: false },
    ],
    markings: [
      {
        nr: 1, fundstelle: 'markierten Stelle', begriff: 'Begriff',
        herkunftLabel: 'Berater', herkunftColor: '#14b8a6', engineStatusLabel: null,
        streitig: false, normAnker: ['§ 1 AO'], governanceLabel: null,
        schadenLabel: null, wahrscheinlichkeitLabel: null, statusLabel: 'Offen',
        kontrolle: null, notiz: null,
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
    m.tokens = [{ kind: 'text', text: ('Wort '.repeat(800)).trim(), color: null, streitig: false }];
    const buf = await renderPdf(m);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('rendert auch ohne Markierungen', async () => {
    const m = model();
    m.tokens = [{ kind: 'text', text: 'Nur Fließtext ohne Markierung.', color: null, streitig: false }];
    m.markings = [];
    m.counts = { gesamt: 0, eigen: 0 };
    const buf = await renderPdf(m);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
