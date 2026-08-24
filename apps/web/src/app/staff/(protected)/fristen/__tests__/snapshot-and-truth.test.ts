// Fachkatalog: TAX-CONTROL-STATUS-001

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');
const exportSource = readFileSync(
  new URL('../../../../api/staff/fristen/export/route.ts', import.meta.url),
  'utf8',
);
const actionSource = readFileSync(new URL('../actions.ts', import.meta.url), 'utf8');

describe('Fristenkontrollbuch — Snapshot- und Wahrheitsgrenzen', () => {
  it('nutzt bei Seite, CSV und Tagesabschluss einen stabilen Snapshot für Vorab- und Hauptqueries', () => {
    // Regression: Unter READ COMMITTED könnte eine nach der Late-ID-Abfrage
    // committete verspätete Einlegung in der Hauptquery erscheinen und dort
    // fälschlich als fristwahrend geschlossen werden. REPEATABLE READ bindet
    // beide Reads an den Datenstand der ersten Transaktionsabfrage.
    expect(pageSource).toContain("{ isolationLevel: 'RepeatableRead' }");
    expect(exportSource).toContain("{ isolationLevel: 'RepeatableRead' }");
    expect(actionSource).toContain("transactionIsolationLevel: 'RepeatableRead'");
  });

  it('benennt alle fünf Quellen und den CSV-Export wahrheitsgemäß als Kontrollauszug', () => {
    expect(pageSource).toContain(
      'Steuertermine, Bescheidprüffälle/Einspruchsfristen, Klagefristen, Anforderungen',
    );
    expect(pageSource).toContain(
      "['Steuertermine', 'Bescheidprüffälle / Einspruchsfristen', 'Klagefristen']",
    );
    expect(pageSource).toContain('CSV-Kontrollauszug');
    expect(pageSource).toContain('CSV-Auszug');
    expect(pageSource).not.toContain('CSV-Nachweis');
  });

  it('übernimmt die wahrheitsgemäße Anzeigeart und den Kontrollhinweis in den CSV-Auszug', () => {
    expect(exportSource).toContain('e.artLabel ?? QUELLE_LABELS[e.quelle]');
    expect(exportSource).toContain("accessor: (e) => e.kontrollhinweis ?? ''");
  });
});
