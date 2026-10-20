// @vitest-environment jsdom
// kk-tcms-qual (s9-Restpunkt): Richtungsisolation der Texte aus dem Tax-CMS.
// Prüft die gemeinsamen Bausteine (components/tcms/text.tsx) und die Prüfhilfe
// (src/__tests__/tcms-isolation.ts), auf der die Isolationstests der Renderer
// aufbauen: Beschreibung, Feststellungen, Durchführung samt Nachweisliste,
// Ereignisse, Portal, Audit sowie Cockpit, Risiken, Kontrollen, Kalender,
// Prüfung, Länder, Profil, Einrichtung, Kommunikation, Arbeitskorb, Portfolio
// (jeweils `… – Richtungsisolation` in den Seitentests).
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { erwarteIsoliert, MARKE, markiert, nichtIsoliert } from '@/__tests__/tcms-isolation';
import { TCMS_TEXT_ISOLIERT, TcmsText, TcmsTextBlock, TcmsTextListe } from '../text';

const RLM = '‏';

describe('Bausteine der Richtungsisolation', () => {
  it('TcmsText isoliert inline mit <bdi>', () => {
    const { container } = render(
      <p>
        F-2026-001 · <TcmsText>{`${RLM}Titel`}</TcmsText> · offen
      </p>,
    );
    const bdi = container.querySelector('bdi');
    expect(bdi?.textContent).toBe(`${RLM}Titel`);
    expect(container.textContent).toBe(`F-2026-001 · ${RLM}Titel · offen`);
  });

  it('TcmsTextBlock und TCMS_TEXT_ISOLIERT setzen dir="auto"', () => {
    const { container } = render(
      <>
        <TcmsTextBlock als="td">Sachverhalt</TcmsTextBlock>
        <span {...TCMS_TEXT_ISOLIERT}>Badge</span>
      </>,
      { container: document.createElement('tr') },
    );
    expect(container.querySelector('td')?.getAttribute('dir')).toBe('auto');
    expect(container.querySelector('span')?.getAttribute('dir')).toBe('auto');
  });

  it('TcmsTextListe isoliert jeden Eintrag und hält die Trenner draußen', () => {
    const { container } = render(
      <p>
        <TcmsTextListe werte={['Shop', `${RLM}Amazon`, 'eBay']} trenner=" · " />
      </p>,
    );
    expect([...container.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual([
      'Shop',
      `${RLM}Amazon`,
      'eBay',
    ]);
    expect(container.textContent).toBe(`Shop · ${RLM}Amazon · eBay`);
  });
});

describe('Prüfhilfe nichtIsoliert/markiert', () => {
  it('meldet einen Text mit Marke ohne Isolation und lässt isolierte zu', () => {
    const { container } = render(
      <div>
        <p>Titel: {`${MARKE}offen${MARKE}`}</p>
        <p>
          Titel: <bdi>{`${MARKE}bdi${MARKE}`}</bdi>
        </p>
        <p dir="auto">{`${MARKE}dir${MARKE}`}</p>
      </div>,
    );
    const { offen, gefunden } = nichtIsoliert(container);
    expect(gefunden).toBe(3);
    expect(offen).toEqual(['div>p: ‹RLM›offen‹RLM›']);
    expect(() => erwarteIsoliert(container)).toThrow();
  });

  it('erwarteIsoliert verlangt mindestens die genannte Zahl markierter Texte', () => {
    const { container } = render(<p>ohne Marke</p>);
    expect(() => erwarteIsoliert(container, 1)).toThrow(/markierte Texte/);
  });

  it('markiert Freitexte, lässt IDs, Codes, Aufzählungen und Daten stehen und bleibt schemagültig', () => {
    const f = tcmsFixtures.feststellungP153();
    const m = markiert(f, ENDPUNKTE.feststellungLesen.antwortSchema);
    expect(m.maskiert).toBe(false);
    if (m.maskiert || f.maskiert) return;
    expect(m.titel).toBe(`${MARKE}${f.titel}${MARKE}`);
    expect(m.sachverhalt).toBe(`${MARKE}${f.sachverhalt}${MARKE}`);
    expect(m.id).toBe(f.id);
    expect(m.nummer).toBe(f.nummer);
    expect(m.status).toBe(f.status);
    expect(m.erfasstAm).toBe(f.erfasstAm);
    expect(ENDPUNKTE.feststellungLesen.antwortSchema.safeParse(m).success).toBe(true);
    // Die Vorlage bleibt unverändert.
    expect(f.titel.includes(MARKE)).toBe(false);
  });
});
