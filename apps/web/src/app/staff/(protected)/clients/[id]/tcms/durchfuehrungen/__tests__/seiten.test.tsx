// @vitest-environment jsdom
// TCMS Stufe 3, Bereich C: Durchführungen (Liste und Kontrolldurchführung) als
// Render-Tests mit Antworten des Dienstes (src/__tests__/tcms-fixtures). Die
// Seiten-Helfer und die Aktionen sind gemockt; die Prüfkette testet
// server/tcms/__tests__/seite.test.ts, die Aktionen actions.test.ts.
// Fachkatalog: TCMS-NACHWEIS-001, TCMS-DIENST-001
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  lesenOptional: vi.fn(),
  namen: vi.fn(),
  tenantLesen: vi.fn(),
  aktion: () => vi.fn(async () => ({ ok: true })),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/server/tcms/seite', () => ({
  tcmsMandantSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsLesenOptional: h.lesenOptional,
  tcmsNamenLesen: h.namen,
  tcmsTenantLesen: h.tenantLesen,
}));
vi.mock('../[did]/actions', () => ({
  durchfuehrungBeginnenAction: h.aktion(),
  durchfuehrungGegenzeichnenAction: h.aktion(),
  durchfuehrungSpeichernAction: h.aktion(),
  durchfuehrungZurueckweisenAction: h.aktion(),
  entfallenAblehnenAction: h.aktion(),
  entfallenBeantragenAction: h.aktion(),
  entfallenFreigebenAction: h.aktion(),
  nachtragAnlegenAction: h.aktion(),
  nachweisAuswaehlenAction: h.aktion(),
  nachweisEntfernenAction: h.aktion(),
  nachweisHochladenAction: h.aktion(),
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import TcmsDurchfuehrungenPage from '../page';
import TcmsDurchfuehrungPage from '../[did]/page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const seiteVon = (staffId: string) => ({
  ok: true,
  art: 'MANDANT',
  session: { user: { tenantId: DEMO.tenant, staffId } },
  akteur: {},
  mandantId: DEMO.talwind,
  mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
  basis: BASIS,
});
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'StB Dr. Anna Roth',
  [DEMO.leon]: 'Leon Brandt',
  [DEMO.thomas]: 'Thomas Weber',
};

type Kanzlei = {
  abgleich: Map<string, string>;
  dokumente: Array<{
    id: string;
    titel: string;
    mime: string;
    groesse: number;
    erstelltAm: string;
  }>;
  berufstraeger: string[];
};
let kanzlei: Kanzlei;

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(seiteVon(DEMO.leon));
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  kanzlei = { abgleich: new Map(), dokumente: [], berufstraeger: [DEMO.anna] };
  h.tenantLesen.mockImplementation(async () => kanzlei);
  h.lesenOptional.mockResolvedValue({
    ok: true,
    daten: tcmsFixtures.kontextTalwind(),
    requestId: 'r',
  });
});

function durchfuehrung(daten: unknown) {
  h.lesen.mockResolvedValue({ ok: true, daten, requestId: 'r' });
}

async function detail(did: string, suche: Record<string, string> = {}) {
  return renderServer(
    TcmsDurchfuehrungPage({
      params: Promise.resolve({ id: DEMO.talwind, did }),
      searchParams: Promise.resolve(suche),
    }),
  );
}

describe('Durchführungen – Liste', () => {
  it('zeigt offene Durchführungen aus dem Kontext mit Status des Dienstes und Links zur Durchführung', async () => {
    const ctx = tcmsFixtures.kontextTalwind();
    await renderServer(
      TcmsDurchfuehrungenPage({
        params: Promise.resolve({ id: DEMO.talwind }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Durchführungen' })).toBeTruthy();
    const offen = ctx.durchfuehrungen.filter((d) =>
      ['FAELLIG', 'IN_DURCHFUEHRUNG', 'ZURUECKGEWIESEN', 'UEBERFAELLIG'].includes(d.anzeige),
    );
    const liste = screen.getByRole('region', { name: /Offen ·/ });
    const zeilen = within(liste).getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(offen.length);
    const erste = offen.sort((a, b) => a.faelligAm.localeCompare(b.faelligAm))[0]!;
    expect(within(zeilen[0]!).getByRole('link').getAttribute('href')).toBe(
      `${BASIS}/durchfuehrungen/${erste.id}`,
    );
    // Aktive Gruppe mit aria-current; Pflichthinweis bei Statusangaben.
    expect(screen.getByRole('link', { current: 'page' }).textContent).toContain('Offen');
    expect(screen.getByRole('note')).toBeTruthy();
    expect(h.namen).toHaveBeenCalledOnce();
  });

  it('filtert per Query und gibt nur einen gültigen Stichtag an den Dienst', async () => {
    await renderServer(
      TcmsDurchfuehrungenPage({
        params: Promise.resolve({ id: DEMO.talwind }),
        searchParams: Promise.resolve({ status: 'abgeschlossen', stand: 'kaputt' }),
      }),
    );
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: {} });
    const liste = screen.getByRole('region', { name: /Abgeschlossen ·/ });
    for (const zeile of within(liste).getAllByRole('row').slice(1)) {
      expect(zeile.textContent).toMatch(/abgeschlossen – (ohne|mit) Befund/);
    }
  });

  it('ohne Programm: Hinweis statt Liste', async () => {
    h.lesenOptional.mockResolvedValue({ ok: true, daten: null, requestId: null });
    await renderServer(
      TcmsDurchfuehrungenPage({
        params: Promise.resolve({ id: DEMO.talwind }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(screen.getByText(/noch kein Tax-CMS-Programm eingerichtet/)).toBeTruthy();
  });
});

describe('Kontrolldurchführung', () => {
  it('in Durchführung (Leon): Editor, Nachweis abrufbar nur nach Abgleich, Upload und Auswahl', async () => {
    const d = tcmsFixtures.durchfuehrungInDurchfuehrung();
    durchfuehrung(d);
    kanzlei.abgleich = new Map([[d.nachweise[0]!.id, 'OK']]);
    kanzlei.dokumente = [
      {
        id: 'd1000000-0000-4000-8000-000000000001',
        titel: 'Kontoauszug',
        mime: 'application/pdf',
        groesse: 2048,
        erstelltAm: '2026-10-01T00:00:00.000Z',
      },
    ];
    const { container } = await detail(d.id);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      'K-EC-03 · Bestellstichprobe Steuerausweis',
    );
    const nachweise = screen.getByRole('region', { name: 'Nachweise' });
    const link = within(nachweise).getByRole('link', { name: 'Kontoabstimmung September.pdf' });
    expect(link.getAttribute('href')).toBe(
      `/api/staff/clients/${DEMO.talwind}/tcms/nachweise/${d.nachweise[0]!.id}`,
    );
    expect(within(nachweise).getByRole('button', { name: /Entfernen/ })).toBeTruthy();
    expect(within(nachweise).getByLabelText('Datei hochladen')).toBeTruthy();
    expect(within(nachweise).getByRole('option', { name: /Kontoauszug/ })).toBeTruthy();
    // Bearbeitbar: Eingaben gehören zum Entwurfsformular, Einreichen angeboten.
    const schritt = screen.getByRole('checkbox', { name: /Stichprobe ziehen/ });
    expect((schritt as HTMLInputElement).disabled).toBe(false);
    expect(schritt.getAttribute('form')).toBe('tcms-durchfuehrung-entwurf');
    expect(screen.getByRole('button', { name: /Zur Gegenzeichnung einreichen/ })).toBeTruthy();
    // Voraussetzungen aus der Prüfung des Dienstes.
    expect(container.textContent).toContain('Schritte 1/3');
    // Daten der kanzleikonsole: Abgleich und Dokumente nur dieses Mandanten.
    expect(h.tenantLesen).toHaveBeenCalledOnce();
    expect(h.lesen.mock.calls[0]![2]).toEqual({ params: { durchfuehrungId: d.id }, query: {} });
  });

  it('Abweichung oder fehlendes Dokument: kein Abruf, sichtbarer Hinweis', async () => {
    const d = tcmsFixtures.durchfuehrungInDurchfuehrung();
    d.nachweise.push({ ...d.nachweise[0]!, id: 'zweiter', dateiname: 'fehlt.pdf' });
    durchfuehrung(d);
    kanzlei.abgleich = new Map([[d.nachweise[0]!.id, 'ABWEICHUNG']]);
    await detail(d.id);
    const nachweise = screen.getByRole('region', { name: 'Nachweise' });
    expect(within(nachweise).queryByRole('link', { name: /Kontoabstimmung/ })).toBeNull();
    expect(within(nachweise).queryByRole('link', { name: /Download/ })).toBeNull();
    expect(within(nachweise).getByText('Abweichung zur Ablage – nicht abrufbar')).toBeTruthy();
    expect(within(nachweise).getByText('Dokument in der Ablage nicht verfügbar')).toBeTruthy();
  });

  it('zur Gegenzeichnung (Anna): Prüferansicht, Zurückweisen als Gefahrendialog, Demo-Nachweis ohne Dokument nicht abrufbar', async () => {
    h.seite.mockResolvedValue(seiteVon(DEMO.anna));
    const d = tcmsFixtures.durchfuehrungGegenzeichnung();
    durchfuehrung(d);
    await detail(d.id);
    expect(screen.getByText(/Prüferansicht — StB Dr. Anna Roth/)).toBeTruthy();
    const nachweise = screen.getByRole('region', { name: 'Nachweise' });
    expect(within(nachweise).queryByRole('link', { name: /Download/ })).toBeNull();
    expect(within(nachweise).queryByLabelText('Datei hochladen')).toBeNull();
    expect(within(nachweise).getByText('Nach Einreichung gesperrt')).toBeTruthy();
    const zurueck = screen.getByRole('button', { name: /Zurückweisen/ });
    expect(zurueck.className).toContain('btn-danger-outline');
    fireEvent.click(zurueck);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText(/Begründung/)).toBeTruthy();
    // Absenden erst ab 30 Zeichen.
    expect(
      (within(dialog).getByRole('button', { name: 'Zurückweisen' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Begründung/), {
      target: { value: 'Stichprobe unvollständig, bitte zweite Liste ergänzen.' },
    });
    expect(
      (within(dialog).getByRole('button', { name: 'Zurückweisen' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('gesperrte Handlungen zeigen den Grund des Dienstes', async () => {
    const d = tcmsFixtures.durchfuehrungFaellig();
    d.rechte.beginnen = {
      erlaubt: false,
      grund: 'Durchführung durch Leon Brandt oder Vertretung Thomas Weber',
    };
    durchfuehrung(d);
    await detail(d.id);
    const beginnen = screen.getByRole('button', { name: /Durchführung beginnen/ });
    expect((beginnen as HTMLButtonElement).disabled).toBe(true);
    expect(beginnen.getAttribute('title')).toBe(
      'Durchführung durch Leon Brandt oder Vertretung Thomas Weber',
    );
  });

  it('abgeschlossen mit Befund: verknüpfte Feststellung, maskiert ohne Titel', async () => {
    h.seite.mockResolvedValue(seiteVon(DEMO.anna));
    const d = tcmsFixtures.durchfuehrungMitBefund();
    const titel = d.feststellungen[0]!.maskiert ? '' : d.feststellungen[0]!.titel;
    d.feststellungen = [
      {
        maskiert: true,
        id: d.feststellungen[0]!.id,
        nummer: 'F-2026-004',
        status: 'GESCHLOSSEN',
        vertraulich: true,
      },
    ];
    durchfuehrung(d);
    const { container } = await detail(d.id);
    expect(
      screen.getByRole('link', {
        name: /Verknüpfte Feststellung F-2026-004 · Vertrauliche Feststellung/,
      }),
    ).toBeTruthy();
    expect(container.textContent).not.toContain(titel);
    expect(screen.getByRole('button', { name: /Nachtrag anlegen/ })).toBeTruthy();
  });

  it('historischer Stand: nur Lesen, keine Formulare, Stichtag an den Dienst', async () => {
    const d = tcmsFixtures.durchfuehrungInDurchfuehrung();
    d.historisch = true;
    d.stand = '2026-10-01';
    durchfuehrung(d);
    await detail(d.id, { stand: '2026-10-01' });
    expect(h.lesen.mock.calls[0]![2]).toEqual({
      params: { durchfuehrungId: d.id },
      query: { stand: '2026-10-01' },
    });
    expect(screen.getByText(/Historischer Stand – nur Lesen/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Entwurf speichern/ })).toBeNull();
    expect(screen.queryByLabelText('Datei hochladen')).toBeNull();
    // Eingaben schreibgeschützt, auch wenn `rechte.bearbeiten` erlaubt wäre.
    expect(d.rechte.bearbeiten.erlaubt).toBe(true);
    const schritt = screen.getByRole('checkbox', { name: /Stichprobe ziehen/ }) as HTMLInputElement;
    expect(schritt.disabled).toBe(true);
    expect(schritt.getAttribute('form')).toBeNull();
    expect(h.tenantLesen).toHaveBeenCalledOnce();
  });

  it('ungültige Durchführungs-ID: 404 ohne Dienstaufruf', async () => {
    await expect(detail('../x')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('Zustand statt Daten, wenn der Dienst nicht lesbar ist', async () => {
    h.lesen.mockResolvedValue({ ok: false, zustand: { art: 'KEIN_ZUGRIFF', neuAnmelden: false } });
    await detail('cmvf9pzy3003jfu7d4oo44g6s');
    expect(screen.getByRole('status').textContent).toMatch(/Kein Zugriff/);
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });
});
