// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Kontrollmatrix als Render-Test mit Antworten des
// Dienstes (src/__tests__/tcms-fixtures). Die Seiten-Helfer sind gemockt.
//
// Schwerpunkte: Vier-Augen-Anzeige bei der Frequenzabweichung, Auswahl der
// Zuständigen nur aus der kanzleikonsole (Seite der Kontrolle bestimmt die
// Liste), maskierte Feststellung ohne Inhalt, Sperre, Zustände.
// Fachkatalog: TCMS-DIENST-001, TCMS-AKTEUR-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  lesenOptional: vi.fn(),
  namen: vi.fn(),
  tenantLesen: vi.fn(),
  kanzleiAuswahl: vi.fn(),
  mandantAuswahl: vi.fn(),
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
vi.mock('@/server/tcms/bereich-b/personen-auswahl', () => ({
  kanzleiPersonenAuswahlTx: h.kanzleiAuswahl,
  mandantPersonenAuswahlTx: h.mandantAuswahl,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsKontrollenPage from '../page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const TX = { tx: 'kontrollen' };

function seite(staffId: string = DEMO.anna) {
  return {
    ok: true,
    art: 'MANDANT',
    session: { user: { tenantId: DEMO.tenant, staffId } },
    akteur: {},
    mandantId: DEMO.talwind,
    mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
    basis: BASIS,
  };
}

const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'Anna Akte',
  [DEMO.leon]: 'Leon Akte',
  [DEMO.thomas]: 'Thomas Akte',
  [DEMO.jana]: 'Jana Akte',
  [DEMO.murat]: 'Murat Akte',
  [DEMO.sabine]: 'Sabine Akte',
};

let kontext: ReturnType<typeof tcmsFixtures.kontextTalwindB>;
let liste: ReturnType<typeof tcmsFixtures.kontrollenTalwind>;

function ok(daten: unknown) {
  return { ok: true, daten, requestId: 'r' };
}

function idVon(code: string): string {
  const k = tcmsFixtures.kontrollenTalwind().kontrollen.find((x) => x.code === code);
  if (!k) throw new Error(code);
  return k.id;
}

function antworten(a: { liste?: unknown; detail?: unknown } = {}) {
  const details: Record<string, unknown> = {
    [idVon('K-EC-02')]: ok(tcmsFixtures.kontrolleKEc02()),
    [idVon('K-EC-08')]: ok(tcmsFixtures.kontrolleKEc08()),
  };
  h.lesenOptional.mockImplementation(
    async (_s: unknown, e: { name: string }, eingabe: { params?: { kontrolleId: string } }) => {
      if (e.name === 'kontextLesen') return ok(kontext);
      if (e.name === 'kontrollenLesen') return a.liste ?? ok(liste);
      if (e.name === 'kontrolleLesen') {
        return a.detail ?? details[eingabe.params!.kontrolleId] ?? ok(null);
      }
      throw new Error(`unerwartet: ${e.name}`);
    },
  );
}

function aufrufe(name: string) {
  return h.lesenOptional.mock.calls.filter((c) => (c[1] as { name: string }).name === name);
}

const params = Promise.resolve({ id: DEMO.talwind });
const mit = (sp: Record<string, string>) => ({ params, searchParams: Promise.resolve(sp) });

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwindB();
  liste = tcmsFixtures.kontrollenTalwind();
  h.seite.mockResolvedValue(seite());
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  h.tenantLesen.mockImplementation(async (_s: unknown, fn: (tx: unknown) => unknown) => fn(TX));
  h.kanzleiAuswahl.mockResolvedValue([
    { id: DEMO.anna, name: 'Anna Akte', funktion: null },
    { id: DEMO.leon, name: 'Leon Akte', funktion: null },
  ]);
  h.mandantAuswahl.mockResolvedValue([
    { id: DEMO.murat, name: 'Murat Akte', funktion: 'Leitung Finanzen' },
  ]);
  antworten();
});

describe('Kontrollmatrix – Liste', () => {
  it('rendert die Kontrollen mit Kennzahlen und Namen aus der kanzleikonsole', async () => {
    const { container } = await renderServer(TcmsKontrollenPage(mit({})));
    expect(screen.getByRole('heading', { level: 2, name: 'Kontrollmatrix' })).toBeTruthy();
    const tabelle = screen.getByRole('region', { name: 'Liste der Kontrollen' });
    expect(within(tabelle).getAllByRole('row')).toHaveLength(liste.kontrollen.length + 1);
    const kennzahlen = screen.getByRole('list', { name: 'Kennzahlen der Kontrollmatrix' });
    expect(kennzahlen.textContent).toContain(`${liste.kontrollen.length} aktiv`);
    expect(kennzahlen.textContent).toContain('1 Abweichung beantragt');
    expect(container.textContent).not.toMatch(/b1000000-0000-4000-8000-0000000000\d\d/);
    expect(container.textContent).not.toContain(UNBEKANNTE_PERSON);
    expect(aufrufe('kontrolleLesen')).toHaveLength(0);
    // Ohne geöffnete Kontrolle keine Personenauswahl.
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });

  it('Pflichtattribute: fehlende laut Dienst in Liste und Detail (TCMS s7), sonst „dokumentiert“', async () => {
    const luecken = [
      'Nachweisanforderung',
      'Gegenzeichnung (Pflicht bei Schlüsselkontrollen)',
    ] as const;
    const k08 = liste.kontrollen.find((k) => k.code === 'K-EC-08')!;
    k08.pflichtattributeOk = false;
    k08.pflichtattributeLuecken = [...luecken];
    const detailDaten = tcmsFixtures.kontrolleKEc08();
    detailDaten.kontrolle.pflichtattributeOk = false;
    detailDaten.kontrolle.pflichtattributeLuecken = [...luecken];
    antworten({ detail: ok(detailDaten) });
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: k08.id })));
    const tabelle = screen.getByRole('region', { name: 'Liste der Kontrollen' });
    expect(tabelle.textContent).toContain(
      'Pflichtattribute unvollständig: Nachweisanforderung, Gegenzeichnung (Pflicht bei Schlüsselkontrollen)',
    );
    const detail = screen.getByRole('region', { name: /^K-EC-08 · / });
    const hinweis = within(detail)
      .getAllByRole('note')
      .find((n) => n.textContent?.includes('Pflichtattribute unvollständig'))!;
    expect(
      within(hinweis)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Nachweisanforderung', 'Gegenzeichnung (Pflicht bei Schlüsselkontrollen)']);
    // Andere Kontrollen ohne Lücken: kein Hinweis in der Liste.
    expect(tabelle.textContent!.match(/Pflichtattribute unvollständig/g)).toHaveLength(1);
  });

  it('maskierte Feststellung: nur die Nummer, kein §-153-Hinweis; lesbare mit Hinweis', async () => {
    await renderServer(TcmsKontrollenPage(mit({})));
    const zeile = (code: string) =>
      within(screen.getByRole('table'))
        .getAllByRole('row')
        .find((z) => z.textContent?.includes(code))!;
    const maskiert = within(zeile('K-EC-04')).getByRole('link', { name: /F-2026-006/ });
    expect(maskiert.textContent).toBe('→ F-2026-006');
    expect(
      within(zeile('K-EC-05')).getByRole('link', { name: /F-2026-007/ }).textContent,
    ).toContain('§ 153 offen');
  });

  it('Matrix-Ansicht über `ansicht=matrix`', async () => {
    await renderServer(TcmsKontrollenPage(mit({ ansicht: 'matrix' })));
    expect(
      screen.getByRole('heading', { level: 3, name: 'Matrix Risiken und Kontrollen' }),
    ).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Ansicht' });
    expect(within(nav).getByRole('link', { name: 'Matrix' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});

describe('Kontrollmatrix – Detail', () => {
  it('liest das Detail nur für eine Kontrolle aus der Liste mit gültiger ID', async () => {
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: 'K EC 02' })));
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: 'gibt_es_nicht' })));
    expect(aufrufe('kontrolleLesen')).toHaveLength(0);
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: idVon('K-EC-08') })));
    expect(aufrufe('kontrolleLesen')[0]![2]).toEqual({
      params: { kontrolleId: idVon('K-EC-08') },
      query: {},
    });
  });

  it.each([
    [DEMO.leon, false],
    [DEMO.anna, true],
  ])(
    'beantragte Abweichung (von Leon): Entscheidung nur für andere Personen (%s → %s)',
    async (ich, angeboten) => {
      h.seite.mockResolvedValue(seite(ich));
      await renderServer(TcmsKontrollenPage(mit({ kontrolle: idVon('K-EC-02') })));
      const detail = screen.getByRole('region', { name: /^K-EC-02 · / });
      expect(within(detail).queryByRole('button', { name: /Abweichung freigeben/ }) !== null).toBe(
        angeboten,
      );
      expect(within(detail).queryByRole('button', { name: 'Ablehnen …' }) !== null).toBe(angeboten);
      expect(
        within(detail).queryByText(
          'Von Ihnen beantragt – die Entscheidung trifft eine zweite Person.',
        ) !== null,
      ).toBe(!angeboten);
      expect(detail.textContent).toContain('beantragt von Leon Akte');
    },
  );

  it('freigegebene Abweichung: Aufheben statt Entscheiden', async () => {
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: idVon('K-EC-08') })));
    const detail = screen.getByRole('region', { name: /^K-EC-08 · / });
    expect(within(detail).getByRole('button', { name: 'Abweichung aufheben …' })).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: /Abweichung freigeben/ })).toBeNull();
    expect(detail.textContent).toContain('freigegeben von Leon Akte');
  });

  it('Mandantenkontrolle: Durchführende aus den Kontakten mit Rolle laut Dienst, Gegenzeichnung aus der Kanzlei', async () => {
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: idVon('K-EC-02') })));
    expect(h.tenantLesen).toHaveBeenCalledOnce();
    const bezug = { tenantId: DEMO.tenant, mandantId: DEMO.talwind };
    expect(h.kanzleiAuswahl).toHaveBeenCalledWith(TX, bezug);
    const rollen = h.mandantAuswahl.mock.calls[0]![2] as Map<string, string | null>;
    expect(h.mandantAuswahl.mock.calls[0]![0]).toBe(TX);
    expect(h.mandantAuswahl.mock.calls[0]![1]).toEqual(bezug);
    // Funktion laut Dienst, Kontakt-IDs klein geschrieben.
    expect(rollen.get(DEMO.jana)).toBe('Geschäftsführerin');
    expect(rollen.get(DEMO.murat)).toBe('Leitung Finanzen');

    const form = screen.getByRole('form', { name: 'Zuständigkeiten ändern' });
    expect((form.querySelector('input[name="partei"]') as HTMLInputElement).value).toBe('MANDANT');
    const durchfuehrend = within(form).getByRole('combobox', { name: 'Durchführend (Mandant)' });
    expect(
      within(durchfuehrend)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['bitte wählen', 'Murat Akte · Leitung Finanzen']);
    expect((durchfuehrend as HTMLSelectElement).value).toBe(DEMO.murat);
    // Bisherige Vertretung (Sabine) steht nicht zur Auswahl: Hinweis statt Vorbelegung.
    const vertretung = within(form).getByRole('combobox', { name: 'Vertretung (Mandant)' });
    expect((vertretung as HTMLSelectElement).value).toBe('');
    expect(form.textContent).toContain('Die bisher eingetragene Person steht nicht zur Auswahl.');
    const gegen = within(form).getByRole('combobox', { name: /Gegenzeichnung/ });
    expect(
      within(gegen)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toContain('Anna Akte');
  });

  it('Kanzleikontrolle: alle Listen aus der Kanzlei, keine Kontakte', async () => {
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: idVon('K-EC-08') })));
    expect(h.mandantAuswahl).not.toHaveBeenCalled();
    const form = screen.getByRole('form', { name: 'Zuständigkeiten ändern' });
    const durchfuehrend = within(form).getByRole('combobox', { name: 'Durchführend (Kanzlei)' });
    expect(
      within(durchfuehrend)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['bitte wählen', 'Anna Akte', 'Leon Akte']);
  });

  it('historischer Stand: keine Personenauswahl, Bedienelemente gesperrt', async () => {
    kontext.historisch = true;
    kontext.stand = '2026-06-30';
    liste.historisch = true;
    liste.stand = '2026-06-30';
    antworten();
    h.seite.mockResolvedValue(seite(DEMO.anna));
    await renderServer(
      TcmsKontrollenPage(mit({ kontrolle: idVon('K-EC-02'), stand: '2026-06-30' })),
    );
    expect(h.tenantLesen).not.toHaveBeenCalled();
    expect(aufrufe('kontrolleLesen')[0]![2]).toEqual({
      params: { kontrolleId: idVon('K-EC-02') },
      query: { stand: '2026-06-30' },
    });
    const detail = screen.getByRole('region', { name: /^K-EC-02 · / });
    expect(within(detail).queryByRole('form', { name: 'Zuständigkeiten ändern' })).toBeNull();
    const freigeben = within(detail).getByRole('button', {
      name: /Abweichung freigeben/,
    }) as HTMLButtonElement;
    expect(freigeben.disabled).toBe(true);
    expect(freigeben.title).toContain('Historischer Stand');
  });

  it('ohne Bearbeitungsrecht: fester Text, keine Personenauswahl', async () => {
    // Recht des Bereichs aus der Liste (TCMS s7); der Kontext erlaubt weiterhin.
    kontext.rechte.bearbeiten = true;
    liste.rechte.bearbeiten = false;
    antworten();
    await renderServer(TcmsKontrollenPage(mit({ kontrolle: idVon('K-EC-08') })));
    expect(h.tenantLesen).not.toHaveBeenCalled();
    const detail = screen.getByRole('region', { name: /^K-EC-08 · / });
    const aufheben = within(detail).getByRole('button', {
      name: 'Abweichung aufheben …',
    }) as HTMLButtonElement;
    expect(aufheben.disabled).toBe(true);
    expect(aufheben.title).toBe(TCMS_KEIN_RECHT.BEARBEITEN);
  });
});

describe('Kontrollmatrix – Zustände', () => {
  it('Störung des Dienstes: Zustand mit requestId', async () => {
    antworten({ liste: { ok: false, zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-7' } } });
    await renderServer(TcmsKontrollenPage(mit({})));
    expect(screen.getByRole('heading', { name: 'Tax-CMS derzeit nicht erreichbar' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('req-7');
  });

  it('Liste unbekannt trotz Kontext: notFound', async () => {
    antworten({ liste: ok(null) });
    await expect(renderServer(TcmsKontrollenPage(mit({})))).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
