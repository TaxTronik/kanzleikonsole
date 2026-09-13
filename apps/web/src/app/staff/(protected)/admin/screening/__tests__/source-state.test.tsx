// Fachkatalog: GWG-SCREENING-001 — reine Darstellung gespeicherter Quellenangaben.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScreeningSourceState } from '../source-state';

describe('EU-Sanktionsquelle: gespeicherter Quellenstand', () => {
  it('erklärt einen fehlenden ersten Abruf ohne einen Prüfstatus zu erfinden', () => {
    const html = renderToStaticMarkup(<ScreeningSourceState state={null} />);
    expect(html).toContain('Noch kein Abruf gespeichert');
    expect(html).toContain('Rufen Sie die offizielle EU-Liste ab');
    expect(html).not.toContain('null');
    expect(html).not.toContain('Zuletzt erfolgreich geprüft');
  });

  it('unterscheidet einen fehlgeschlagenen Abruf ohne Bestand vom Erstaufruf', () => {
    const html = renderToStaticMarkup(
      <ScreeningSourceState
        state={{
          attemptedAt: new Date('2026-09-13T10:30:00Z'),
          checkedAt: null,
          lastError: 'Abruf oder Validierung fehlgeschlagen.',
          snapshot: null,
        }}
      />,
    );
    expect(html).toContain('Letzter Abruffehler');
    expect(html).toContain('Abruf oder Validierung fehlgeschlagen.');
    expect(html).toContain('Letzter Abrufversuch');
    expect(html).toContain('Nicht gespeichert');
    expect(html).toContain('Noch kein Datenbestand gespeichert.');
    expect(html).not.toContain('Noch kein Abruf gespeichert');
  });

  it('zeigt bei einem späteren Fehler den erhaltenen Bestand und den Fehler nebeneinander', () => {
    const html = renderToStaticMarkup(
      <ScreeningSourceState
        state={{
          attemptedAt: new Date('2026-09-13T10:30:00Z'),
          checkedAt: new Date('2026-09-12T10:30:00Z'),
          lastError: 'Letzter gültiger Bestand bleibt erhalten.',
          snapshot: {
            sourceVersion: 'EU-Testversion',
            publishedAt: new Date('2026-09-01T08:00:00Z'),
            importedAt: new Date('2026-09-12T10:00:00Z'),
            entryCount: 1234,
            sha256: 'a'.repeat(64),
          },
        }}
      />,
    );
    expect(html).toContain('Letzter Abruffehler');
    expect(html).toContain('Gespeicherter Datenbestand');
    expect(html).toContain('EU-Testversion');
    expect(html).toContain('1.234');
    expect(html).toContain('a'.repeat(64));
    expect(html).not.toContain('Noch kein Datenbestand gespeichert.');
    expect(html).not.toContain('Abruf aktuell');
  });
});
