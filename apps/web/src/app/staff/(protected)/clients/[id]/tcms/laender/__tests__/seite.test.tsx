// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Länder-Monitor als Render-Test mit Antworten des
// Dienstes (src/__tests__/tcms-fixtures). Schwerpunkte: Detail nur für ein
// Land im Monitor, Erfassen nur ohne Sperre, Namen der Erfassenden aus der
// kanzleikonsole, Feststellungen mit Länderbezug.
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
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/tcms/seite', () => ({
  tcmsMandantSeite: h.seite,
  tcmsLesenOptional: h.lesenOptional,
  tcmsNamenLesen: h.namen,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { erwarteIsoliert, markiert } from '@/__tests__/tcms-isolation';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsLaenderPage from '../page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const PFAD = `${BASIS}/laender`;
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
let monitor: ReturnType<typeof tcmsFixtures.laenderTalwind>;

const params = Promise.resolve({ id: DEMO.talwind });
const mit = (sp: Record<string, string>) => ({ params, searchParams: Promise.resolve(sp) });

function ok(daten: unknown) {
  return { ok: true, daten, requestId: 'r' };
}

function antworten(a: { monitor?: unknown } = {}) {
  h.lesenOptional.mockImplementation(async (_s: unknown, e: { name: string }) => {
    if (e.name === 'kontextLesen') return ok(kontext);
    if (e.name === 'laenderLesen') return a.monitor ?? ok(monitor);
    throw new Error(`unerwartet: ${e.name}`);
  });
}

function tabelle() {
  return screen.getByRole('table', { name: /^Länder im Monitor/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwindB();
  monitor = tcmsFixtures.laenderTalwind();
  h.seite.mockResolvedValue(SEITE);
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) =>
      id === DEMO.leon ? 'Leon Akte' : id ? UNBEKANNTE_PERSON : KEINE_PERSON,
    bekannt: (id: string | null) => id === DEMO.leon,
  }));
  antworten();
});

describe('Länder-Monitor', () => {
  it('liest Kontext und Monitor mit demselben Stichtag; Länder, Schwelle und Datenstand', async () => {
    await renderServer(TcmsLaenderPage(mit({})));
    const namen = h.lesenOptional.mock.calls.map((c) => (c[1] as { name: string }).name).sort();
    expect(namen).toEqual(['kontextLesen', 'laenderLesen']);
    for (const c of h.lesenOptional.mock.calls) expect(c[2]).toEqual({ query: {} });
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Länder-Monitor – Umsatzsteuer & Registrierungen',
      }),
    ).toBeTruthy();
    expect(within(tabelle()).getAllByRole('row')).toHaveLength(kontext.laender.length + 1);
    expect(screen.getByText(/Datenstand 30\.09\.2026 \(manuell erfasst\)\./)).toBeTruthy();
    const schwelle = screen.getByRole('region', { name: /^EU-Fernverkäufe – Schwelle/ });
    expect(schwelle.textContent).toContain('Schwelle überschritten');
    expect(schwelle.textContent).toContain('Leon Akte');
    expect(schwelle.textContent).not.toContain(DEMO.leon);
    // Feststellung mit Länderbezug verlinkt.
    const cz = within(tabelle())
      .getAllByRole('row')
      .find((z) => z.textContent?.includes('CZ'))!;
    expect(
      within(cz)
        .getByRole('link', { name: /F-2026-007/ })
        .getAttribute('href'),
    ).toBe(`${BASIS}/feststellungen/${monitor.feststellungen[0]!.eintraege[0]!.id}`);
  });

  it('öffnet ein Land nur mit gültigem Code aus dem Monitor', async () => {
    for (const land of ['fr', 'DE', 'FR<', 'XX']) {
      document.body.innerHTML = '';
      await renderServer(TcmsLaenderPage(mit({ land })));
      expect(screen.queryByRole('region', { name: /Registrierungen und Fristen$/ })).toBeNull();
    }
    document.body.innerHTML = '';
    await renderServer(TcmsLaenderPage(mit({ land: 'CZ' })));
    const detail = screen.getByRole('region', { name: 'CZ – Registrierungen und Fristen' });
    expect(
      within(detail)
        .getByRole('link', { name: /schließen$/ })
        .getAttribute('href'),
    ).toBe(PFAD);
    // Feststellung mit Titel (nicht vertraulich) und §-153-Hinweis.
    expect(detail.textContent).toContain('§-153-Würdigung offen');
    // Formular für den neuen Stand mit Werten des jüngsten Stands.
    const form = within(detail).getByRole('form', { name: 'Neuen Stand für CZ erfassen' });
    const lfd = within(form).getByRole('textbox', { name: /Fernverkäufe lfd\. Jahr/ });
    expect((lfd as HTMLInputElement).value).toBe('61200');
  });

  it('Bezüge des Landes laut Dienst (TCMS s7): Risiken mit Grund, Kontrollen, Ereignisse mit Links', async () => {
    await renderServer(TcmsLaenderPage(mit({ land: 'CZ' })));
    const detail = screen.getByRole('region', { name: 'CZ – Registrierungen und Fristen' });
    const bezuege = within(detail).getByRole('region', { name: 'Bezüge im Tax-CMS' });
    const cz = monitor.bezuege.find((b) => b.land === 'CZ')!;
    // Risiken: Code mit Link ins Inventar (ID aus dem Kontext), Grund des Dienstes.
    const ust04 = kontext.risiken.find((r) => r.code === 'EC-UST-04')!;
    const link = within(bezuege).getByRole('link', { name: 'EC-UST-04' });
    expect(link.getAttribute('href')).toBe(`${BASIS}/risiken?risiko=${ust04.id}`);
    expect(link.parentElement!.textContent).toBe(
      `EC-UST-04 – ${cz.risiken.find((r) => r.code === 'EC-UST-04')!.grund}`,
    );
    // Nicht im Kontext geführte Risiken bzw. Kontrollen: ohne Link.
    expect(within(bezuege).queryByRole('link', { name: 'EC-UST-03' })).toBeNull();
    expect(bezuege.textContent).toContain('EC-UST-03');
    const k02 = kontext.kontrollen.find((k) => k.code === 'K-EC-02')!;
    expect(within(bezuege).getByRole('link', { name: 'K-EC-02' }).getAttribute('href')).toBe(
      `${BASIS}/kontrollen?kontrolle=${k02.id}`,
    );
    expect(within(bezuege).queryByRole('link', { name: 'K-EC-03' })).toBeNull();
    // Ereignis mit Nummer und Titel aus dem Kontext.
    const e329 = kontext.ereignisse.find((e) => e.nummer === '2026-T-0329')!;
    const ereignis = within(bezuege).getByRole('link', { name: /^2026-T-0329 – / });
    expect(ereignis.getAttribute('href')).toBe(`${BASIS}/ereignisse?e=${e329.id}`);
  });

  it('Bezüge: Stichtag in den Links; ungültige Ereignis-ID ohne Link; keine Bezüge → Hinweis', async () => {
    monitor.bezuege = monitor.bezuege.map((b) =>
      b.land === 'FR' ? { ...b, ereignisse: ['../admin', 'unbekannt_1'] } : b,
    );
    monitor.historisch = true;
    monitor.stand = '2026-09-30';
    kontext.historisch = true;
    kontext.stand = '2026-09-30';
    antworten();
    await renderServer(TcmsLaenderPage(mit({ land: 'FR', stand: '2026-09-30' })));
    const bezuege = screen.getByRole('region', { name: 'Bezüge im Tax-CMS' });
    const links = within(bezuege)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(links.every((h) => h!.endsWith('stand=2026-09-30'))).toBe(true);
    expect(links.some((h) => h!.includes('admin'))).toBe(false);
    expect(
      within(bezuege)
        .getByRole('link', { name: /nicht aufgeführt/ })
        .getAttribute('href'),
    ).toBe(`${BASIS}/ereignisse?e=unbekannt_1&stand=2026-09-30`);
    document.body.innerHTML = '';
    monitor.bezuege = monitor.bezuege.filter((b) => b.land !== 'FR');
    monitor.historisch = false;
    kontext.historisch = false;
    antworten();
    await renderServer(TcmsLaenderPage(mit({ land: 'FR' })));
    expect(screen.getByRole('region', { name: 'Bezüge im Tax-CMS' }).textContent).toContain(
      'Keine Risiken, Kontrollen oder Ereignisse',
    );
  });

  it('Sammelerfassung nur mit `erfassen=1` und ohne Sperre; je Land eine Feldgruppe', async () => {
    await renderServer(TcmsLaenderPage(mit({ erfassen: '1' })));
    const form = screen.getByRole('form', { name: 'Länderdaten erfassen' });
    expect((form.querySelector('input[name="sammel"]') as HTMLInputElement).value).toBe('1');
    expect(
      within(form)
        .getAllByRole('group')
        .map((g) => g.firstChild?.textContent),
    ).toContain('CZ · Tschechien');
    expect(form.querySelector('input[name="CZ.fernverkaeufeLfdEur"]')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Land hinzufügen' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Erfassung schließen/ })).toBeTruthy();
  });

  it('ohne Bearbeitungsrecht: keine Erfassung, kein Formular im Detail, Grund sichtbar', async () => {
    // Recht des Bereichs aus der Liste (TCMS s7); der Kontext erlaubt weiterhin.
    kontext.rechte.bearbeiten = true;
    monitor.rechte.bearbeiten = false;
    antworten();
    await renderServer(TcmsLaenderPage(mit({ erfassen: '1', land: 'FR' })));
    expect(screen.queryByRole('form', { name: 'Länderdaten erfassen' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Land hinzufügen' })).toBeNull();
    const knopf = screen.getByRole('button', {
      name: /Daten manuell erfassen/,
    }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(knopf.title).toBe(TCMS_KEIN_RECHT.BEARBEITEN);
    const detail = screen.getByRole('region', { name: 'FR – Registrierungen und Fristen' });
    expect(within(detail).queryByRole('form')).toBeNull();
    expect(detail.textContent).toContain(TCMS_KEIN_RECHT.BEARBEITEN);
  });

  it('historischer Stand: Stichtag an beide Endpunkte, keine Erfassung', async () => {
    kontext.historisch = true;
    kontext.stand = '2026-07-31';
    monitor.historisch = true;
    monitor.stand = '2026-07-31';
    antworten();
    await renderServer(TcmsLaenderPage(mit({ stand: '2026-07-31', erfassen: '1' })));
    for (const c of h.lesenOptional.mock.calls) {
      expect(c[2]).toEqual({ query: { stand: '2026-07-31' } });
    }
    expect(screen.queryByRole('form', { name: 'Länderdaten erfassen' })).toBeNull();
    const fr = within(tabelle()).getByRole('link', { name: /FR/ });
    expect(fr.getAttribute('href')).toBe(`${PFAD}?stand=2026-07-31&land=FR`);
  });

  it('noch keine Länder: Leerzustand mit „Erstes Land erfassen“ (nur ohne Sperre)', async () => {
    kontext.laender = [];
    monitor.historie = [];
    monitor.feststellungen = [];
    antworten();
    await renderServer(TcmsLaenderPage(mit({})));
    expect(screen.getByRole('link', { name: 'Erstes Land erfassen' }).getAttribute('href')).toBe(
      `${PFAD}?erfassen=1#land-neu`,
    );
    document.body.innerHTML = '';
    // Recht des Bereichs aus der Liste (TCMS s7); der Kontext erlaubt weiterhin.
    kontext.rechte.bearbeiten = true;
    monitor.rechte.bearbeiten = false;
    antworten();
    await renderServer(TcmsLaenderPage(mit({})));
    expect(screen.queryByRole('link', { name: 'Erstes Land erfassen' })).toBeNull();
  });

  it('Zustände: Störung des Monitors; Monitor unbekannt trotz Kontext: notFound', async () => {
    antworten({ monitor: { ok: false, zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-8' } } });
    await renderServer(TcmsLaenderPage(mit({})));
    expect(screen.getByRole('status').textContent).toContain('req-8');
    antworten({ monitor: ok(null) });
    await expect(renderServer(TcmsLaenderPage(mit({})))).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

// kk-tcms-qual (s9-Rest): Ländernamen, Bezüge, Fristen und Hinweise isoliert.
describe('Länder-Monitor – Richtungsisolation', () => {
  it.each<Record<string, string>>([{}, { land: 'CZ' }])('Monitor %o isoliert', async (sp) => {
    kontext = markiert(kontext, ENDPUNKTE.kontextLesen.antwortSchema);
    monitor = markiert(monitor, ENDPUNKTE.laenderLesen.antwortSchema);
    antworten();
    const { container } = await renderServer(TcmsLaenderPage(mit(sp)));
    erwarteIsoliert(container, 3);
  });
});
