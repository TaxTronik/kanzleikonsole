// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Anzeigehilfen und Freigabeauswahl des
// Risikoinventars. Filter wählen aus der Antwort des Dienstes aus; die
// Freigabeauswahl bietet der einreichenden Person die Freigabe nicht an
// (Vier-Augen-Anzeige) – ob ein Schritt zulässig ist, entscheidet der Dienst.
// Fachkatalog: TCMS-DIENST-001
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Die Filter lesen Query-Werte über bereich-b/seite (Texte aus server/tcms/zustand).
vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import type { TcmsAktionsErgebnis } from '../../bereich-b/ergebnis';
import {
  filtereRisiken,
  risikoFilterAktiv,
  risikoFilterAus,
  risikoFilterParameter,
} from '../filter';
import { FreigabeAuswahl } from '../freigabe-auswahl';
import { freigabeAuswahl, kurzName, risikoAuditPersonen, risikoAuditText } from '../labels';

type Aktion = (vorher: TcmsAktionsErgebnis | null, fd: FormData) => Promise<TcmsAktionsErgebnis>;

const SPERRE = 'Historischer Stand – Änderungen sind nur am aktuellen Stand möglich.';
const name = (id: string | null) => (id === DEMO.anna ? 'Anna Akte' : id ? 'Unbekannt' : '—');

describe('Freigabeauswahl', () => {
  it('Sperre vor allem; bewertet → einreichbar; eigene Einreichung nicht freigebbar', () => {
    const auswahl = freigabeAuswahl(null, DEMO.leon);
    expect(auswahl({ freigabe: 'BEWERTET', freigabeEingereichtVon: null })).toBe(true);
    expect(auswahl({ freigabe: 'ZUR_FREIGABE', freigabeEingereichtVon: DEMO.anna })).toBe(true);
    expect(
      auswahl({ freigabe: 'ZUR_FREIGABE', freigabeEingereichtVon: DEMO.leon.toUpperCase() }),
    ).toMatch(/^Von Ihnen eingereicht/);
    expect(auswahl({ freigabe: 'FREIGEGEBEN', freigabeEingereichtVon: DEMO.anna })).toBe(
      'Status freigegeben',
    );
    expect(
      freigabeAuswahl(SPERRE, DEMO.leon)({ freigabe: 'BEWERTET', freigabeEingereichtVon: null }),
    ).toBe(SPERRE);
  });

  it('sendet die Auswahl mit dem Schritt des Auslösers; nach Erfolg ist die Auswahl leer', async () => {
    const aktion = vi
      .fn<Aktion>()
      .mockResolvedValueOnce({ ok: false, error: 'Bitte mindestens ein Risiko auswählen.' })
      .mockResolvedValueOnce({ ok: true, meldung: 'EC-GOB-02 freigegeben.' });
    render(
      <FreigabeAuswahl aktion={aktion} fuss="2 Risiken">
        <input type="checkbox" name="risikoIds" value="r1" aria-label="r1 auswählen" />
        <input type="checkbox" name="risikoIds" value="r2" aria-label="r2 auswählen" />
      </FreigabeAuswahl>,
    );
    const r2 = screen.getByRole('checkbox', { name: 'r2 auswählen' }) as HTMLInputElement;
    fireEvent.click(r2);
    fireEvent.click(screen.getByRole('button', { name: /Freigeben \(zweite Person\)/ }));
    await waitFor(() => expect(aktion).toHaveBeenCalledOnce());
    expect([...aktion.mock.calls[0]![1].entries()]).toEqual([
      ['risikoIds', 'r2'],
      ['schritt', 'freigeben'],
    ]);
    expect(await screen.findByRole('alert')).toBeTruthy();
    // Fehler: Auswahl bleibt stehen.
    expect(r2.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Zur Freigabe einreichen/ }));
    await waitFor(() => expect(aktion).toHaveBeenCalledTimes(2));
    expect(aktion.mock.calls[1]![1].get('schritt')).toBe('einreichen');
    expect((await screen.findByRole('status')).textContent).toBe('EC-GOB-02 freigegeben.');
    await waitFor(() => expect(r2.checked).toBe(false));
  });
});

describe('Risikotabelle: gesperrte Auswahl', () => {
  it('nennt den Sperrgrund als zugängliche Beschreibung, nicht nur als Tooltip', async () => {
    const { RisikoTabelle } = await import('../inventar');
    const daten = tcmsFixtures.risikenTalwind();
    const [frei, gesperrt] = daten.risiken;
    render(
      <RisikoTabelle
        risiken={[frei!, gesperrt!]}
        kontrollen={[]}
        appetit="MITTEL"
        betriebAktiv={false}
        namen={{ name: () => '—', bekannt: () => false } as never}
        optionen={{
          mitAuswahl: true,
          auswahl: (r) => (r.id === gesperrt!.id ? SPERRE : true),
          detailHref: () => '#',
          ausgewaehlt: null,
        }}
      />,
    );
    const zu = screen.getByRole('checkbox', { name: `${gesperrt!.code} auswählen` });
    expect((zu as HTMLInputElement).disabled).toBe(true);
    const beschreibung = document.getElementById(zu.getAttribute('aria-describedby') ?? '');
    expect(beschreibung?.textContent).toBe(SPERRE);
    const offen = screen.getByRole('checkbox', { name: `${frei!.code} auswählen` });
    expect(offen.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('Filter des Risikoinventars', () => {
  const liste = tcmsFixtures.risikenTalwind().risiken;

  it('übernimmt nur feste Werte; Heatmap-Zelle nur vollständig', () => {
    const f = risikoFilterAus({ gruppe: 'UST', gt: 'XX', klasse: 'HOCH', s: 'H', appetit: '1' });
    expect(f).toMatchObject({
      gruppe: 'UST',
      gt: '',
      klasse: 'HOCH',
      s: '',
      w: '',
      appetit: true,
    });
    expect(risikoFilterParameter(f)).toEqual({ gruppe: 'UST', klasse: 'HOCH', appetit: '1' });
    expect(risikoFilterAktiv(risikoFilterAus({}))).toBe(false);
    const zelle = risikoFilterAus({ s: 'H', w: 'MOEGLICH' });
    expect(risikoFilterParameter(zelle)).toEqual({ s: 'H', w: 'MOEGLICH' });
  });

  it('filtert nach Werten der Antwort und sortiert über Appetit zuerst', () => {
    const alle = filtereRisiken(liste, risikoFilterAus({}));
    expect(alle).toHaveLength(liste.length);
    const ueber = alle.filter((r) => r.ueberAppetit).length;
    expect(alle.slice(0, ueber).every((r) => r.ueberAppetit)).toBe(true);
    const zelle = filtereRisiken(liste, risikoFilterAus({ s: 'H', w: 'MOEGLICH' }));
    expect(zelle.map((r) => r.code).sort()).toEqual(
      liste
        .filter((r) => r.s === 'H' && r.w === 'MOEGLICH')
        .map((r) => r.code)
        .sort(),
    );
    const uebersteuert = filtereRisiken(liste, risikoFilterAus({ uebersteuert: '1' }));
    // EC-UST-01: beantragt; EC-UST-02: freigegeben (übersteuert).
    expect(uebersteuert.map((r) => r.code).sort()).toEqual(['EC-UST-01', 'EC-UST-02']);
  });
});

describe('Audit-Texte und Namen', () => {
  it('bekannte Felder mit Typprüfung; Personen nur als Name', () => {
    const detail = {
      vorher: { s: 'M', w: 'MOEGLICH', r: 2, gt: 'FP' },
      nachher: { s: 'H', w: 'MOEGLICH', r: 2, gt: 'FP' },
      sicht: 'BETRIEB',
      berechnet: 'HOCH',
      klasse: 'MITTEL',
      beantragtVon: DEMO.anna,
      empfaengerId: DEMO.leon,
      begruendung: 'Weil.',
      fremd: '<script>',
    };
    const text = risikoAuditText(detail, name);
    expect(text).toBe(
      'M/möglich/2/FP → H/möglich/2/FP · Netto Betrieb: hoch → mittel · an Unbekannt · beantragt von Anna Akte · „Weil.“',
    );
    expect(text).not.toContain(DEMO.anna);
    expect(risikoAuditPersonen(detail)).toEqual([DEMO.leon, DEMO.anna]);
    // Unerwartete Typen werden ignoriert.
    expect(risikoAuditText({ sicht: 'X', klasse: 1, beantragtVon: 5 }, name)).toBe('');
  });

  it('kurzName für Tabellen', () => {
    expect(kurzName('StB Dr. Anna Roth')).toBe('Dr. Roth');
    expect(kurzName('Leon Brandt')).toBe('L. Brandt');
    expect(kurzName('Jana')).toBe('Jana');
  });
});
