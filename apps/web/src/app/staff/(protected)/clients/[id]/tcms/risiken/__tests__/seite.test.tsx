// @vitest-environment jsdom
// TCMS Stufe 3, Bereich B: Risikoinventar als Render-Test mit Antworten des
// Dienstes (src/__tests__/tcms-fixtures). Die Seiten-Helfer sind gemockt; ihre
// Prüfkette testet server/tcms/__tests__/seite.test.ts.
//
// Schwerpunkte: Lesen nur mit geprüften Parametern, Namen aus der
// kanzleikonsole (nicht aus `namen` des Dienstes), Vier-Augen-Anzeige (wer
// beantragt/eingereicht hat, bekommt die Entscheidung nicht angeboten),
// Sperre bei historischem Stand oder ohne Bearbeitungsrecht, Zustände.
// Fachkatalog: TCMS-DIENST-001
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  lesenOptional: vi.fn(),
  namen: vi.fn(),
  tenantLesen: vi.fn(),
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

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsRisikenPage from '../page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const PFAD = `${BASIS}/risiken`;

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

/** Namen bewusst anders als im Dienst: angezeigt wird nur die kanzleikonsole. */
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'Anna Akte',
  [DEMO.leon]: 'Leon Akte',
  [DEMO.jana]: 'Jana Akte',
  [DEMO.murat]: 'Murat Akte',
};

type Antworten = {
  kontext?: unknown;
  liste?: unknown;
  detail?: Record<string, unknown>;
};

let kontext: ReturnType<typeof tcmsFixtures.kontextTalwindB>;
let liste: ReturnType<typeof tcmsFixtures.risikenTalwind>;

function ok(daten: unknown) {
  return { ok: true, daten, requestId: 'r' };
}

function antworten(a: Antworten = {}) {
  const details: Record<string, unknown> = {
    [idVon('EC-UST-01')]: ok(tcmsFixtures.risikoEcUst01()),
    [idVon('EC-UST-02')]: ok(tcmsFixtures.risikoEcUst02()),
    [idVon('EC-VER-01')]: ok(tcmsFixtures.risikoEcVer01()),
    ...a.detail,
  };
  h.lesenOptional.mockImplementation(
    async (_s: unknown, endpunkt: { name: string }, eingabe: { params?: { risikoId: string } }) => {
      switch (endpunkt.name) {
        case 'kontextLesen':
          return a.kontext ?? ok(kontext);
        case 'risikenLesen':
          return a.liste ?? ok(liste);
        case 'risikoLesen':
          return details[eingabe.params!.risikoId] ?? ok(null);
        default:
          throw new Error(`unerwartet: ${endpunkt.name}`);
      }
    },
  );
}

function idVon(code: string): string {
  const r = tcmsFixtures.risikenTalwind().risiken.find((x) => x.code === code);
  if (!r) throw new Error(code);
  return r.id;
}

function aufrufe(name: string) {
  return h.lesenOptional.mock.calls.filter((c) => (c[1] as { name: string }).name === name);
}

const params = Promise.resolve({ id: DEMO.talwind });
const mit = (sp: Record<string, string>) => ({ params, searchParams: Promise.resolve(sp) });

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwindB();
  liste = tcmsFixtures.risikenTalwind();
  h.seite.mockResolvedValue(seite());
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  h.tenantLesen.mockResolvedValue([]);
  antworten();
});

describe('Risikoinventar – Liste', () => {
  it('rendert das Inventar aus der Antwort des Dienstes mit Namen aus der kanzleikonsole', async () => {
    const { container } = await renderServer(TcmsRisikenPage(mit({})));
    expect(screen.getByRole('heading', { level: 2, name: 'Risikoinventar' })).toBeTruthy();
    const tabelle = screen.getByRole('table');
    expect(within(tabelle).getAllByRole('row')).toHaveLength(liste.risiken.length + 1);
    // Über Appetit zuerst (Sortierung der Anzeige), dann Bruttoklasse.
    const codes = within(tabelle)
      .getAllByRole('row')
      .slice(1)
      .map((z) => within(z).getAllByRole('link')[0]!.textContent);
    expect(
      codes
        .slice(0, 4)
        .every((c) => ['EC-GOB-01', 'EC-UST-01', 'EC-UST-05', 'EC-VER-01'].includes(c!)),
    ).toBe(true);
    // Verantwortliche: Name aus der kanzleikonsole, nie die ID.
    expect(container.textContent).toContain('M. Akte');
    expect(container.querySelector('td[title="Murat Akte"]')).toBeTruthy();
    expect(container.textContent).not.toContain(DEMO.murat);
    expect(container.textContent).not.toContain('Unbekannte Person');
    // Gelesen: Kontext und Inventar ohne Stichtag, kein Detail.
    expect(aufrufe('kontextLesen')[0]![2]).toEqual({ query: {} });
    expect(aufrufe('risikenLesen')[0]![2]).toEqual({ query: {} });
    expect(aufrufe('risikoLesen')).toHaveLength(0);
  });

  it('Freigabeauswahl: bewertete und fremd eingereichte Risiken; eigene Einreichung nicht (Vier-Augen-Anzeige)', async () => {
    // EC-GOB-02 hat Leon eingereicht.
    h.seite.mockResolvedValue(seite(DEMO.leon));
    await renderServer(TcmsRisikenPage(mit({})));
    const form = screen.getByRole('form', { name: 'Risiken zur Freigabe auswählen' });
    const box = (code: string) =>
      within(form).getByRole('checkbox', { name: `${code} auswählen` }) as HTMLInputElement;
    expect(box('EC-GOB-03').disabled).toBe(false);
    expect(box('EC-GOB-02').disabled).toBe(true);
    expect(box('EC-GOB-02').title).toContain('Von Ihnen eingereicht');
    expect(box('EC-UST-01').disabled).toBe(true);

    h.seite.mockResolvedValue(seite(DEMO.anna));
    document.body.innerHTML = '';
    await renderServer(TcmsRisikenPage(mit({})));
    const form2 = screen.getByRole('form', { name: 'Risiken zur Freigabe auswählen' });
    const box2 = within(form2).getByRole('checkbox', {
      name: 'EC-GOB-02 auswählen',
    }) as HTMLInputElement;
    expect(box2.disabled).toBe(false);
    expect(box2.value).toBe(idVon('EC-GOB-02'));
  });

  it('filtert nur mit Werten aus festen Auswahlen; fremde Werte zählen nicht', async () => {
    await renderServer(TcmsRisikenPage(mit({ gruppe: 'UST', kern: '1' })));
    expect(screen.getByText('Keine Risiken für diese Filter.')).toBeTruthy();
    document.body.innerHTML = '';
    await renderServer(TcmsRisikenPage(mit({ gruppe: 'UST' })));
    const zeilen = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(liste.risiken.filter((r) => r.gruppe === 'UST').length);
    document.body.innerHTML = '';
    await renderServer(TcmsRisikenPage(mit({ gruppe: '<script>', klasse: 'ALLE' })));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(
      liste.risiken.length + 1,
    );
  });

  it('Heatmap-Ansicht über `ansicht=heatmap`, Umschalter mit aria-current', async () => {
    await renderServer(TcmsRisikenPage(mit({ ansicht: 'heatmap' })));
    const nav = screen.getByRole('navigation', { name: 'Ansicht' });
    expect(within(nav).getByRole('link', { name: 'Heatmap' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Heatmap der Risiken' })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Risiken zur Freigabe auswählen' })).toBeNull();
  });

  it('historischer Stand: Stichtag an den Dienst, keine Auswahl, Sperrhinweis', async () => {
    kontext.historisch = true;
    kontext.stand = '2026-06-30';
    liste.historisch = true;
    liste.stand = '2026-06-30';
    antworten();
    await renderServer(TcmsRisikenPage(mit({ stand: '2026-06-30' })));
    expect(aufrufe('kontextLesen')[0]![2]).toEqual({ query: { stand: '2026-06-30' } });
    expect(aufrufe('risikenLesen')[0]![2]).toEqual({ query: { stand: '2026-06-30' } });
    expect(screen.queryByRole('form', { name: 'Risiken zur Freigabe auswählen' })).toBeNull();
    expect(
      screen.getAllByRole('note').some((n) => n.textContent?.includes('Historischer Stand')),
    ).toBe(true);
    // Links behalten den Stichtag.
    const link = within(screen.getByRole('table')).getAllByRole('link')[0]!;
    expect(link.getAttribute('href')).toContain('stand=2026-06-30');
  });
});

describe('Risikoinventar – Detail', () => {
  it('liest das Detail nur für ein Risiko aus dem Inventar mit gültiger ID', async () => {
    await renderServer(TcmsRisikenPage(mit({ risiko: '../../admin' })));
    await renderServer(TcmsRisikenPage(mit({ risiko: 'unbekannt_123' })));
    expect(aufrufe('risikoLesen')).toHaveLength(0);
    await renderServer(TcmsRisikenPage(mit({ risiko: idVon('EC-UST-02') })));
    expect(aufrufe('risikoLesen')).toHaveLength(1);
    expect(aufrufe('risikoLesen')[0]![2]).toEqual({
      params: { risikoId: idVon('EC-UST-02') },
      query: {},
    });
  });

  it('öffnet den Detailbereich mit Überschrift, Schließen-Link und Bedienung', async () => {
    await renderServer(TcmsRisikenPage(mit({ risiko: idVon('EC-UST-02') })));
    const detail = screen.getByRole('region', { name: /^EC-UST-02 · / });
    expect(within(detail).getByRole('heading', { level: 3 })).toBeTruthy();
    expect(
      within(detail)
        .getByRole('link', { name: /schließen$/ })
        .getAttribute('href'),
    ).toBe(PFAD);
    expect(within(detail).getByRole('button', { name: /Neu bewerten/ })).toBeTruthy();
    // Die Zeile im Inventar ist markiert.
    const zeile = screen.getAllByRole('row').find((z) => z.getAttribute('aria-current') === 'true');
    expect(zeile?.textContent).toContain('EC-UST-02');
  });

  it.each([
    [DEMO.anna, false],
    [DEMO.leon, true],
  ])(
    'beantragte Übersteuerung (von Anna): Entscheidung nur für andere Personen (%s → %s)',
    async (ich, angeboten) => {
      h.seite.mockResolvedValue(seite(ich));
      await renderServer(TcmsRisikenPage(mit({ risiko: idVon('EC-UST-01') })));
      const detail = screen.getByRole('region', { name: /^EC-UST-01 · / });
      const freigeben = within(detail).queryByRole('button', { name: /Übersteuerung freigeben/ });
      const ablehnen = within(detail).queryByRole('button', { name: 'Ablehnen …' });
      expect(freigeben !== null).toBe(angeboten);
      expect(ablehnen !== null).toBe(angeboten);
      const hinweis = within(detail).queryByText(
        'Von Ihnen beantragt – die Entscheidung trifft eine zweite Person.',
      );
      expect(hinweis !== null).toBe(!angeboten);
      // Wer beantragt hat, steht als Name aus der kanzleikonsole da.
      expect(detail.textContent).toContain('beantragt von Anna Akte');
    },
  );

  it.each([
    [DEMO.leon, false],
    [DEMO.anna, true],
  ])(
    'eingereichte Freigabe (von Leon): Freigeben/Zurückweisen nur für andere Personen (%s → %s)',
    async (ich, angeboten) => {
      h.seite.mockResolvedValue(seite(ich));
      const gob02 = liste.risiken.find((r) => r.code === 'EC-GOB-02')!;
      antworten({ detail: { [gob02.id]: ok({ ...tcmsFixtures.risikoEcUst01(), risiko: gob02 }) } });
      await renderServer(TcmsRisikenPage(mit({ risiko: gob02.id })));
      const detail = screen.getByRole('region', { name: /^EC-GOB-02 · / });
      expect(within(detail).queryByRole('button', { name: /^Freigeben$/ }) !== null).toBe(
        angeboten,
      );
      expect(within(detail).queryByRole('button', { name: 'Zurückweisen …' }) !== null).toBe(
        angeboten,
      );
      expect(
        within(detail).queryByText(
          'Von Ihnen eingereicht – die Freigabe erteilt eine zweite Person.',
        ) !== null,
      ).toBe(!angeboten);
    },
  );

  it('ohne Bearbeitungsrecht laut Dienst: Bedienelemente gesperrt mit Grund', async () => {
    kontext.rechte.bearbeiten = false;
    antworten();
    h.seite.mockResolvedValue(seite(DEMO.leon));
    await renderServer(TcmsRisikenPage(mit({ risiko: idVon('EC-UST-01') })));
    const detail = screen.getByRole('region', { name: /^EC-UST-01 · / });
    const neu = within(detail).getByRole('button', { name: /Neu bewerten/ }) as HTMLButtonElement;
    expect(neu.disabled).toBe(true);
    expect(neu.title).toBe(TCMS_KEIN_RECHT.BEARBEITEN);
    expect(
      (within(detail).getByRole('button', { name: /Übersteuerung freigeben/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole('form', { name: 'Risiken zur Freigabe auswählen' })).toBeNull();
    // Ohne Bearbeitungsrecht wird die gesetzliche Vertretung nicht gelesen.
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });

  it('Risikoakzeptanz: nur aktive Kontakte dieses Mandanten mit Rolle laut Dienst', async () => {
    h.tenantLesen.mockResolvedValue([
      { id: DEMO.jana, name: 'Jana Weller', email: 'j@x', aktiv: true, funktion: null },
      { id: DEMO.murat, name: 'Murat Yilmaz', email: 'm@x', aktiv: true, funktion: null },
      { id: DEMO.sabine, name: 'Sabine Inaktiv', email: 's@x', aktiv: false, funktion: null },
    ]);
    kontext.kontaktRollen.push({
      kontaktId: DEMO.sabine,
      rolle: 'GESETZLICHER_VERTRETER',
      funktion: 'Prokura',
    });
    // EC-UST-05 liegt über dem Appetit und hat keine offene Akzeptanz.
    const ust05 = liste.risiken.find((r) => r.code === 'EC-UST-05')!;
    antworten({ detail: { [ust05.id]: ok({ ...tcmsFixtures.risikoEcVer01(), risiko: ust05 }) } });
    await renderServer(TcmsRisikenPage(mit({ risiko: ust05.id })));
    expect(h.tenantLesen).toHaveBeenCalledOnce();
    const detail = screen.getByRole('region', { name: /^EC-UST-05 · / });
    fireEvent.click(within(detail).getByRole('button', { name: /Risikoakzeptanz anfordern/ }));
    const dialog = screen.getByRole('dialog');
    const auswahl = within(dialog).getByRole('combobox', { name: /Gesetzliche Vertretung/ });
    const optionen = within(auswahl)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(optionen).toEqual(['bitte wählen', 'Jana Weller (Geschäftsführerin)']);
  });

  it('offene Akzeptanz: kein zweites Anfordern, Grund mit Namen aus der kanzleikonsole', async () => {
    await renderServer(TcmsRisikenPage(mit({ risiko: idVon('EC-VER-01') })));
    const detail = screen.getByRole('region', { name: /^EC-VER-01 · / });
    const knopf = within(detail).getByRole('button', {
      name: /Risikoakzeptanz anfordern/,
    }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(knopf.title).toContain('wartet auf Jana Akte');
  });

  it('offene Akzeptanz unzustellbar: Status mit Grund, Verweis auf die Neuadressierung', async () => {
    const ver01 = liste.risiken.find((r) => r.code === 'EC-VER-01')!;
    ver01.akzeptanzen[0]!.zustellung = {
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: '2026-10-02T08:00:00.000Z',
      status: 'UNZUSTELLBAR',
      am: '2026-10-09T08:00:00.000Z',
      grund: 'ABGELAUFEN',
    };
    await renderServer(TcmsRisikenPage(mit({ risiko: ver01.id })));
    const detail = screen.getByRole('region', { name: /^EC-VER-01 · / });
    expect(detail.textContent).toContain('Nachricht unzustellbar');
    expect(detail.textContent).toContain('Zustellfrist abgelaufen');
    expect(detail.textContent).toContain(
      'Die gesetzliche Vertretung hat die Anforderung nicht erhalten.',
    );
    const link = within(detail).getByRole('link', { name: 'Neu adressieren (Kommunikation)' });
    expect(link.getAttribute('href')).toBe(`${BASIS}/kommunikation`);
    // Kein zweites Anfordern; der Sperrgrund nennt die gescheiterte Zustellung.
    const knopf = within(detail).getByRole('button', {
      name: /Risikoakzeptanz anfordern/,
    }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(knopf.title).toContain('Anforderung: Nachricht unzustellbar (Zustellfrist abgelaufen)');
    expect(knopf.title).toContain('unter Kommunikation neu adressieren');
  });

  it('offene Akzeptanz verworfen ohne Bearbeitungsrecht: Status, aber kein Verweis', async () => {
    kontext.rechte.bearbeiten = false;
    const ver01 = liste.risiken.find((r) => r.code === 'EC-VER-01')!;
    ver01.akzeptanzen[0]!.zustellung = {
      zweck: 'FREIGABE_CODE',
      erstelltAm: '2026-10-02T08:00:00.000Z',
      status: 'VERWORFEN',
      am: '2026-10-03T08:00:00.000Z',
    };
    antworten();
    await renderServer(TcmsRisikenPage(mit({ risiko: ver01.id })));
    const detail = screen.getByRole('region', { name: /^EC-VER-01 · / });
    expect(detail.textContent).toContain('Nachricht nicht ausgeliefert');
    expect(detail.textContent).toContain('nicht erhalten');
    expect(within(detail).queryByRole('link', { name: /Neu adressieren/ })).toBeNull();
  });

  it('zugestellte Akzeptanz: Status ohne Hinweis', async () => {
    const ver01 = liste.risiken.find((r) => r.code === 'EC-VER-01')!;
    ver01.akzeptanzen[0]!.zustellung = {
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: '2026-10-02T08:00:00.000Z',
      status: 'ZUGESTELLT',
      am: '2026-10-02T08:01:00.000Z',
    };
    await renderServer(TcmsRisikenPage(mit({ risiko: ver01.id })));
    const detail = screen.getByRole('region', { name: /^EC-VER-01 · / });
    expect(detail.textContent).toContain('Nachricht zugestellt');
    expect(detail.textContent).not.toContain('nicht erhalten');
    const knopf = within(detail).getByRole('button', { name: /Risikoakzeptanz anfordern/ });
    expect(knopf.title).not.toContain('neu adressieren');
  });

  it('Störung beim Detail: Zustand im Detailbereich, Inventar bleibt', async () => {
    antworten({
      detail: {
        [idVon('EC-UST-02')]: {
          ok: false,
          zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-9' },
        },
      },
    });
    await renderServer(TcmsRisikenPage(mit({ risiko: idVon('EC-UST-02') })));
    expect(screen.getByRole('table')).toBeTruthy();
    const detail = screen.getByRole('region', { name: /^EC-UST-02 · / });
    expect(within(detail).getByRole('status').textContent).toContain('req-9');
  });
});

describe('Risikoinventar – Zustände', () => {
  it('Störung des Dienstes: Zustand mit requestId statt Daten', async () => {
    antworten({ liste: { ok: false, zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-1' } } });
    await renderServer(TcmsRisikenPage(mit({})));
    expect(screen.getByRole('heading', { name: 'Tax-CMS derzeit nicht erreichbar' })).toBeTruthy();
    expect(h.namen).not.toHaveBeenCalled();
  });

  it('Mandant nicht im Tax-CMS: Hinweis; Inventar unbekannt trotz Kontext: notFound', async () => {
    antworten({ kontext: ok(null) });
    await renderServer(TcmsRisikenPage(mit({})));
    expect(screen.getByRole('link', { name: 'Zum Cockpit' }).getAttribute('href')).toBe(BASIS);
    antworten({ liste: ok(null) });
    await expect(renderServer(TcmsRisikenPage(mit({})))).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('ohne Programm: „Tax-CMS einrichten“ nur mit Bearbeitungsrecht', async () => {
    kontext.programm = null;
    kontext.rechte.bearbeiten = false;
    antworten();
    const { container } = await renderServer(TcmsRisikenPage(mit({})));
    expect(screen.queryByRole('link', { name: 'Tax-CMS einrichten' })).toBeNull();
    expect(container.textContent).toContain(TCMS_KEIN_RECHT.BEARBEITEN);
  });

  it('kein Zugriff auf den Mandanten: nichts lesen', async () => {
    h.seite.mockResolvedValue({ ok: false, zustand: { art: 'NICHT_KONFIGURIERT' } });
    await renderServer(TcmsRisikenPage(mit({})));
    expect(h.lesenOptional).not.toHaveBeenCalled();
  });
});
