// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Kontrollkalender als Render-Test mit dem Kontext
// des Dienstes (src/__tests__/tcms-fixtures). Die Seite liest nur den
// Kontext; Filter und Zeitfenster kommen aus geprüften GET-Parametern.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesenOptional: vi.fn(),
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
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { erwarteIsoliert, markiert } from '@/__tests__/tcms-isolation';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import TcmsKalenderPage from '../page';

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

function kalender() {
  return screen.getByRole('table', { name: /^Durchführungen je Kontrolle und Fälligkeitsmonat/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwindB();
  h.seite.mockResolvedValue(SEITE);
  h.lesenOptional.mockImplementation(async () => ({ ok: true, daten: kontext, requestId: 'r' }));
});

describe('Kontrollkalender', () => {
  it('liest nur den Kontext und zeigt zwölf Monate ab Wirksamkeitsbeginn', async () => {
    await renderServer(TcmsKalenderPage(mit({})));
    expect(h.lesenOptional).toHaveBeenCalledOnce();
    expect((h.lesenOptional.mock.calls[0]![1] as { name: string }).name).toBe('kontextLesen');
    expect(screen.getByRole('heading', { level: 2, name: 'Kontrollkalender' })).toBeTruthy();
    const kopf = within(kalender()).getAllByRole('columnheader');
    // Kontrolle + 12 Monate; Wirksamkeitsbeginn 07/2026 liegt im Jahresfenster des Stichtags.
    expect(kopf).toHaveLength(13);
    expect(kopf[1]!.textContent).toContain('Jul 26');
    expect(kopf[12]!.textContent).toContain('Jun 27');
    // Monat des Stichtags (10/2026) als aktuelles Datum.
    expect(kopf.find((k) => k.getAttribute('aria-current') === 'date')?.textContent).toContain(
      'Okt 26',
    );
    expect(within(kalender()).getAllByRole('rowheader')).toHaveLength(kontext.kontrollen.length);
  });

  it('Status je Durchführung als zugänglicher Name, Link auf die Durchführung', async () => {
    await renderServer(TcmsKalenderPage(mit({})));
    const d = kontext.durchfuehrungen.find((x) => x.anzeige === 'UEBERFAELLIG')!;
    const link = within(kalender()).getByRole('link', {
      name: new RegExp(`^${d.code} ${d.periodeLabel}.*: Überfällig, fällig`),
    });
    expect(link.getAttribute('href')).toBe(`${BASIS}/durchfuehrungen/${encodeURIComponent(d.id)}`);
  });

  it('Filter Partei und Schlüsselkontrollen aus festen Auswahlen; fremde Werte zählen nicht', async () => {
    await renderServer(TcmsKalenderPage(mit({ partei: 'MANDANT' })));
    const mandant = kontext.kontrollen.filter((k) => k.partei === 'MANDANT').length;
    expect(within(kalender()).getAllByRole('rowheader')).toHaveLength(mandant);
    const filter = screen.getByRole('navigation', { name: 'Filter des Kalenders' });
    expect(within(filter).getByRole('link', { name: 'Mandant' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // Der Schlüssel-Link behält den Parteifilter.
    expect(
      within(filter)
        .getByRole('link', { name: /nur Schlüsselkontrollen/ })
        .getAttribute('href'),
    ).toBe(`${BASIS}/kalender?partei=MANDANT&schluessel=1`);

    document.body.innerHTML = '';
    await renderServer(TcmsKalenderPage(mit({ partei: 'ALLE<script>', schluessel: 'ja' })));
    expect(within(kalender()).getAllByRole('rowheader')).toHaveLength(kontext.kontrollen.length);

    document.body.innerHTML = '';
    await renderServer(TcmsKalenderPage(mit({ schluessel: '1' })));
    expect(within(kalender()).getAllByRole('rowheader')).toHaveLength(
      kontext.kontrollen.filter((k) => k.schluessel).length,
    );
    expect(screen.getByText(/^gefiltert · /)).toBeTruthy();
  });

  it('Zeitfenster aus `ab` nur in gültiger Form; Navigation in Zwölfmonatsschritten', async () => {
    await renderServer(TcmsKalenderPage(mit({ ab: '2026-01' })));
    let kopf = within(kalender()).getAllByRole('columnheader');
    expect(kopf[1]!.textContent).toContain('Jan 26');
    const nav = screen.getByRole('navigation', { name: 'Zeitraum des Kalenders' });
    expect(
      within(nav)
        .getByRole('link', { name: /12 Monate zurück/ })
        .getAttribute('href'),
    ).toBe(`${BASIS}/kalender?ab=2025-01`);
    expect(
      within(nav)
        .getByRole('link', { name: /12 Monate vor/ })
        .getAttribute('href'),
    ).toBe(`${BASIS}/kalender?ab=2027-01`);

    document.body.innerHTML = '';
    await renderServer(TcmsKalenderPage(mit({ ab: '2026-13' })));
    kopf = within(kalender()).getAllByRole('columnheader');
    expect(kopf[1]!.textContent).toContain('Jul 26');
    // Ein ungültiger Wert wird nicht in Links weitergereicht.
    const filter = screen.getByRole('navigation', { name: 'Filter des Kalenders' });
    expect(within(filter).getByRole('link', { name: 'Kanzlei' }).getAttribute('href')).toBe(
      `${BASIS}/kalender?partei=KANZLEI`,
    );
  });

  it('Prüflast je Monat mit Gesamtzeile; historischer Stand bleibt in Links', async () => {
    kontext.historisch = true;
    kontext.stand = '2026-09-30';
    await renderServer(TcmsKalenderPage(mit({ stand: '2026-09-30' })));
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: { stand: '2026-09-30' } });
    const last = screen.getByRole('table', {
      name: 'Anzahl Durchführungen je Monat und Governance-Typ',
    });
    const zeilen = within(last)
      .getAllByRole('rowheader')
      .map((z) => z.textContent);
    expect(zeilen).toEqual([
      'FP · periodisch',
      'FF · laufend',
      'IN · Aufklärung',
      'Auslösungen',
      'Gesamt',
    ]);
    const link = within(kalender()).getAllByRole('link')[0]!;
    expect(link.getAttribute('href')).toContain('stand=2026-09-30');
  });

  it('Zustände: Mandant nicht im Tax-CMS, ohne Programm, Störung', async () => {
    h.lesenOptional.mockResolvedValueOnce({ ok: true, daten: null, requestId: null });
    await renderServer(TcmsKalenderPage(mit({})));
    expect(screen.getByRole('link', { name: 'Zum Cockpit' })).toBeTruthy();

    document.body.innerHTML = '';
    kontext.programm = null;
    await renderServer(TcmsKalenderPage(mit({})));
    expect(screen.getByRole('link', { name: 'Tax-CMS einrichten' })).toBeTruthy();

    document.body.innerHTML = '';
    h.lesenOptional.mockResolvedValueOnce({
      ok: false,
      zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-3' },
    });
    await renderServer(TcmsKalenderPage(mit({})));
    expect(screen.getByRole('status').textContent).toContain('req-3');
  });
});

// kk-tcms-qual (s9-Rest): Kontrolltitel und Perioden im Kalender isoliert.
describe('Kontrollkalender – Richtungsisolation', () => {
  it('Titel und Perioden isoliert', async () => {
    kontext = markiert(kontext, ENDPUNKTE.kontextLesen.antwortSchema);
    const { container } = await renderServer(TcmsKalenderPage(mit({})));
    erwarteIsoliert(container, 3);
  });
});
