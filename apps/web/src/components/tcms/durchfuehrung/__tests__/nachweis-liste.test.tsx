// @vitest-environment jsdom
// Integration TCMS Stufe 3: eine Darstellung der Nachweise für die
// Durchführung der Kanzlei (Bereich C) und die Kontrollaufgabe im Portal
// (Bereich D). Schutzregeln der Anzeige:
//   - Kennt die Seite den Abgleich mit der Ablage, gibt es bei Abweichung oder
//     fehlendem Dokument keinen Link und keinen Download (die Route prüft
//     zusätzlich selbst).
//   - Ohne Abgleich (Portal) verlinkt die Liste auf die Route; nur diese
//     liefert nach dem SHA-256-Abgleich aus.
//   - Entfernen nur über das Bedienelement der Seite (Recht und Sperre laut
//     Dienst entscheidet die Seite).
//   - Dateinamen aus der eigenen Ablage; ohne Dokument der Dienstwert nur
//     bereinigt (RT3B-K-04).
// Fachkatalog: TCMS-NACHWEIS-001
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { erwarteIsoliert, MARKE } from '@/__tests__/tcms-isolation';
import { NachweisListe, type Nachweis, type NachweisListeProps } from '../nachweis-liste';

const namen = { name: (id: string | null | undefined) => (id ? `Person ${id.slice(-2)}` : '—') };

function liste(nachweise: readonly Nachweis[], extra: Partial<NachweisListeProps> = {}) {
  return render(
    <NachweisListe
      id="liste"
      titel="Anlagen"
      ebene="h2"
      nachweise={nachweise}
      mindest={2}
      anforderung="Kontoauszug"
      ausgeblendet={0}
      namen={namen}
      abrufHref={(id) => `/api/x/${id}`}
      aenderbarBis="Übermitteln"
      entfernen={() => null}
      fuss={<p>Fuß</p>}
      {...extra}
    />,
  );
}

describe('NachweisListe', () => {
  const nachweise = tcmsFixtures.portalAufgabeK23Murat().nachweise;

  it('ohne Abgleich (Portal): Link und Herunterladen über die Route, Zähler gegen die Mindestanzahl', () => {
    liste(nachweise);
    const region = screen.getByRole('region', { name: 'Anlagen' });
    expect(within(region).getByRole('heading', { level: 2, name: 'Anlagen' })).toBeTruthy();
    for (const n of nachweise) {
      const links = within(region).getAllByRole('link', { name: new RegExp(n.dateiname) });
      expect(links.map((l) => l.getAttribute('href'))).toEqual([
        `/api/x/${n.id}`,
        `/api/x/${n.id}`,
      ]);
    }
    expect(within(region).getByText(`${nachweise.length} von mind. 2`)).toBeTruthy();
    expect(within(region).getByText('Fuß')).toBeTruthy();
  });

  it('mit Abgleich (Kanzlei): Abweichung oder fehlendes Dokument ohne Link, mit Hinweis', () => {
    const [a, b] = nachweise;
    liste([a!, b!], {
      titel: 'Nachweise',
      ebene: 'h3',
      abgleich: new Map([[a!.id, 'ABWEICHUNG' as const]]),
    });
    const region = screen.getByRole('region', { name: 'Nachweise' });
    expect(within(region).queryAllByRole('link')).toHaveLength(0);
    expect(within(region).getByText('Abweichung zur Ablage – nicht abrufbar')).toBeTruthy();
    expect(within(region).getByText('Dokument in der Ablage nicht verfügbar')).toBeTruthy();
    expect(within(region).getByRole('heading', { level: 3, name: 'Nachweise' })).toBeTruthy();
  });

  it('RT3B-K-04: Dateiname aus der eigenen Ablage; ohne Ablage nur bereinigt, nie der Dienstwert', () => {
    const [a, b] = nachweise;
    const boese = [
      { ...a!, dateiname: 'Rechnung\u202efdp.exe' },
      { ...b!, dateiname: 'Liste\u2066/../\u2069x.csv\u200b' },
    ];
    const { container } = liste(boese, {
      dateinamen: new Map([[a!.id, 'Kassenbericht Oktober.pdf']]),
    });
    const html = container.innerHTML;
    // Steuer-, Format- und Richtungszeichen des Dienstes erreichen die Seite nicht.
    expect(html).not.toMatch(/[\u200b\u202a-\u202e\u2066-\u2069]/);
    expect(html).not.toContain('fdp.exe');
    expect(screen.getAllByRole('link', { name: /Kassenbericht Oktober\.pdf/ })).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: /Liste_\.\._x\.csv/ })).toHaveLength(2);
  });

  it('Richtungsisolation (kk-tcms-qual): eigener Name und bereinigter Dienstwert in <bdi>', () => {
    const [a, b] = nachweise;
    const { container } = liste([a!, { ...b!, dateiname: `${MARKE}Liste.csv${MARKE}` }], {
      dateinamen: new Map([[a!.id, `${MARKE}Kassenbericht Oktober.pdf${MARKE}`]]),
    });
    // Name aus der eigenen Ablage: Link und Herunterladen isoliert.
    erwarteIsoliert(container, 2);
    // Dienstwert ohne eigenes Dokument: Marken entfallen (RT3B-K-04), isoliert bleibt er.
    const orte = screen.getAllByText('Liste.csv');
    expect(orte).toHaveLength(2);
    for (const ort of orte) expect(ort.tagName).toBe('BDI');
  });

  it('Entfernen nur, wo die Seite ein Bedienelement liefert; Sperre sichtbar', () => {
    const [offen, gesperrt] = [
      { ...nachweise[0]!, gesperrt: false },
      { ...nachweise[0]!, id: 'gesperrt', gesperrt: true },
    ];
    liste([offen, gesperrt], {
      entfernen: (n) => (n.gesperrt ? null : <button type="button">Entfernen {n.id}</button>),
    });
    expect(screen.getAllByRole('button', { name: /Entfernen/ })).toHaveLength(1);
    expect(screen.getByText('bis zum Übermitteln änderbar')).toBeTruthy();
    expect(screen.getByText(/gesperrt ·/)).toBeTruthy();
  });

  it('leer: Erwartung der Kontrolle statt Liste', () => {
    liste([]);
    // Die Erwartung des Dienstes steht in <bdi> (kk-tcms-qual): ganzer Absatz.
    expect(
      screen.getByText(
        (_, e) =>
          e?.tagName === 'P' &&
          e.textContent === 'Noch keine Anlagen hochgeladen. Erwartet: Kontoauszug.',
      ),
    ).toBeTruthy();
  });
});
