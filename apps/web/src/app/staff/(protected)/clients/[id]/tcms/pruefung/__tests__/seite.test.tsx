// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Prüfungsvorbereitung als Render-Test mit dem
// Kontext des Dienstes (src/__tests__/tcms-fixtures). Zahlen des
// Wirksamkeitszeitraums kommen aus `zeitraum`; die Lückenanalyse zählt nur
// nach dem Status des Dienstes; maskierte Feststellungen zählen ohne Inhalt.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesenOptional: vi.fn(),
  namen: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/server/tcms/seite', () => ({
  tcmsMandantSeite: h.seite,
  tcmsLesenOptional: h.lesenOptional,
  tcmsNamenLesen: h.namen,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import TcmsPruefungPage from '../page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const SEITE = {
  ok: true,
  art: 'MANDANT',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.anna } },
  akteur: {},
  mandantId: DEMO.talwind,
  mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
  basis: BASIS,
};

let kontext: ReturnType<typeof tcmsFixtures.kontextTalwindB>;

const params = Promise.resolve({ id: DEMO.talwind });
const mit = (sp: Record<string, string>) => ({ params, searchParams: Promise.resolve(sp) });

/** Anzahl einer Zeile der Lückenanalyse (letzte Spalte, ohne „n. a.“-Text). */
function luecke(text: string): string {
  const karte = screen.getByRole('region', { name: 'Lückenanalyse' });
  const link = within(karte).getByRole('link', { name: new RegExp(`^${text}`) });
  return link.querySelector('.font-mono')!.textContent!;
}

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwindB();
  h.seite.mockResolvedValue(SEITE);
  h.lesenOptional.mockImplementation(async () => ({ ok: true, daten: kontext, requestId: 'r' }));
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) =>
      id === DEMO.jana ? 'Jana Akte' : id ? UNBEKANNTE_PERSON : KEINE_PERSON,
    bekannt: (id: string | null) => id === DEMO.jana,
  }));
});

describe('Prüfungsvorbereitung', () => {
  it('zeigt Gegenstand, Phase und Zahlen des Zeitraums aus dem Dienst', async () => {
    await renderServer(TcmsPruefungPage(mit({})));
    expect(h.lesenOptional).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { level: 2, name: 'Prüfungsvorbereitung' })).toBeTruthy();
    const gegenstand = screen.getByRole('region', { name: 'Prüfungsgegenstand' });
    expect(gegenstand.textContent).toContain('30.06.2026');
    expect(gegenstand.textContent).toContain('Monat 4 von 6');
    expect(gegenstand.textContent).toContain(`Phase ${kontext.aktivePhase} von 7`);
    const zr = screen.getByRole('region', { name: 'Durchführungen im Zeitraum' });
    const werte = Object.fromEntries(
      within(zr)
        .getAllByRole('term')
        .map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
    expect(werte['fällig gewordene Durchführungen']).toBe('71');
    expect(werte['abgeschlossen und gegengezeichnet']).toBe('56');
    expect(werte['warten auf Gegenzeichnung']).toBe('3');
  });

  it('Lückenanalyse nach Status des Dienstes; maskierte Feststellungen ohne Schwere zählen nicht', async () => {
    await renderServer(TcmsPruefungPage(mit({})));
    expect(luecke('Durchführungen ohne ausreichende Nachweise')).toBe('0');
    expect(luecke('Durchführungen ohne Gegenzeichnung')).toBe('3');
    expect(luecke('Überfällige Durchführungen')).toBe(
      String(kontext.durchfuehrungen.filter((d) => d.anzeige === 'UEBERFAELLIG').length),
    );
    // F-2026-007 (hoch, in Würdigung); F-2026-006 ist maskiert, F-2026-004 geschlossen.
    expect(luecke('Offene Feststellungen hoch/kritisch')).toBe('1');
    expect(luecke('Offene §-153-Würdigungen')).toBe('1');
    expect(luecke('CMS-Beschreibung nicht freigegeben')).toBe('0');
    expect(luecke('Risiken ohne Freigabe')).toBe(
      String(kontext.risiken.filter((r) => r.freigabe !== 'FREIGEGEBEN').length),
    );
    const karte = screen.getByRole('region', { name: 'Lückenanalyse' });
    expect(
      within(karte)
        .getByRole('link', { name: /^Offene §-153/ })
        .getAttribute('href'),
    ).toBe(`${BASIS}/feststellungen`);
  });

  it('vor Beginn des Wirksamkeitszeitraums: Zeitraumzeilen „nicht anwendbar“', async () => {
    kontext.programm!.wirksamAb = '2027-01-01T00:00:00.000Z';
    kontext.programm!.wirksamBis = '2027-12-31T00:00:00.000Z';
    await renderServer(TcmsPruefungPage(mit({})));
    expect(luecke('Durchführungen ohne Gegenzeichnung')).toContain('nicht anwendbar');
    expect(luecke('Überfällige Durchführungen')).not.toContain('nicht anwendbar');
    expect(screen.getByRole('region', { name: 'Prüfungsgegenstand' }).textContent).toContain(
      'beginnt 01.01.2027',
    );
  });

  it('freigegebene Beschreibungsversionen mit Namen aus der kanzleikonsole und Hash', async () => {
    const { container } = await renderServer(TcmsPruefungPage(mit({})));
    expect(h.namen).toHaveBeenCalledWith(SEITE, [DEMO.jana]);
    const karte = screen.getByRole('region', { name: 'Freigegebene Beschreibungsversionen' });
    const zeilen = within(karte).getAllByRole('row').slice(1);
    expect(zeilen.map((z) => within(z).getAllByRole('cell')[0]!.textContent)).toEqual([
      'v1.1 freigegeben',
      'v1.0 abgelöst',
    ]);
    expect(zeilen[0]!.textContent).toContain('Jana Akte');
    expect(zeilen[0]!.textContent).toContain('SHA-256');
    expect(container.textContent).not.toContain(DEMO.jana);
  });

  it('Nachweispaket: Schaltfläche gesperrt und mit Hinweis verknüpft', async () => {
    await renderServer(TcmsPruefungPage(mit({})));
    const knopf = screen.getByRole('button', { name: /Nachweispaket erzeugen/ });
    expect((knopf as HTMLButtonElement).disabled).toBe(true);
    expect(knopf.getAttribute('aria-describedby')).toBe('tcms-nachweispaket-hinweis');
    expect(document.getElementById('tcms-nachweispaket-hinweis')).toBeTruthy();
  });

  it('ohne festgelegten Zeitraum: Leerzustand statt Zahlen', async () => {
    kontext.zeitraum = null;
    await renderServer(TcmsPruefungPage(mit({})));
    expect(screen.getByText('Der Wirksamkeitszeitraum ist noch nicht festgelegt.')).toBeTruthy();
  });

  it('historischer Stand: Stichtag an den Dienst und in den Links', async () => {
    kontext.historisch = true;
    kontext.stand = '2026-09-30';
    await renderServer(TcmsPruefungPage(mit({ stand: '2026-09-30' })));
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: { stand: '2026-09-30' } });
    const karte = screen.getByRole('region', { name: 'Lückenanalyse' });
    for (const link of within(karte).getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/[?&]stand=2026-09-30$/);
    }
  });

  it('Zustände: Störung mit requestId; ohne Programm Einrichtungshinweis', async () => {
    h.lesenOptional.mockResolvedValueOnce({
      ok: false,
      zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-5' },
    });
    await renderServer(TcmsPruefungPage(mit({})));
    expect(screen.getByRole('status').textContent).toContain('req-5');
    expect(h.namen).not.toHaveBeenCalled();

    document.body.innerHTML = '';
    kontext.programm = null;
    await renderServer(TcmsPruefungPage(mit({})));
    expect(screen.getByRole('link', { name: 'Tax-CMS einrichten' })).toBeTruthy();
  });
});
