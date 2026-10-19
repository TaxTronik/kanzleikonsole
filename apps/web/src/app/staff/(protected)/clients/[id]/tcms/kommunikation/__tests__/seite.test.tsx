// @vitest-environment jsdom
// TCMS Stufe 3, Bereich A: Kommunikation (Freigaben, Kenntnisnahmen,
// Freigabestände, Meldewege) als Render-Test mit Antworten des Dienstes
// (Demo-Mandant Talwind: zwei offene Anforderungen). Die Seiten-Helfer sind
// gemockt; ihre Prüfkette testet server/tcms/__tests__/seite.test.ts.
// Geprüft wird: Status zum Stichtag aus dem Dienst, Namen aus der
// kanzleikonsole, „Neu adressieren“ nur für offene Anforderungen mit Recht und
// nur an Kontakte dieses Mandanten mit passender Rolle; Zustellstatus der
// jüngsten Nachricht je Anforderung (TCMS s6) mit Hinweis auf die
// Neuadressierung, wenn die Person sie nicht erhalten hat.
// Fachkatalog: TCMS-DIENST-001
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
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
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import TcmsKommunikationPage from '../page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const SEITE = {
  ok: true,
  art: 'MANDANT',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.anna, roles: ['EMPLOYEE'] } },
  akteur: {},
  mandantId: DEMO.talwind,
  mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
  basis: BASIS,
};
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'StB Dr. Anna Roth',
  [DEMO.jana]: 'Jana Weller',
  [DEMO.murat]: 'Murat Yilmaz',
  [DEMO.sabine]: 'Sabine Kraus',
};

function daten() {
  const kontext = tcmsFixtures.kontextTalwind();
  const historie = tcmsFixtures.freigabenTalwind();
  h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: 'r' });
  h.lesen.mockResolvedValue({ ok: true, daten: historie, requestId: 'r' });
  return { kontext, historie };
}

async function rendern(sp: Record<string, string> = {}) {
  return renderServer(
    TcmsKommunikationPage({
      params: Promise.resolve({ id: DEMO.talwind }),
      searchParams: Promise.resolve(sp),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(SEITE);
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
});

describe('Kommunikation', () => {
  it('Freigaben und Kenntnisnahmen mit Status des Dienstes und Namen der kanzleikonsole', async () => {
    daten();
    await rendern();
    const freigaben = screen.getByRole('table', { name: 'Freigaben' });
    const zeilen = within(freigaben).getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]!.textContent).toContain('CMS-Beschreibung v1.2');
    expect(zeilen[0]!.textContent).toContain('Jana Weller');
    expect(zeilen[0]!.textContent).toContain('offen');
    const kenntnis = screen.getByRole('table', { name: 'Kenntnisnahmen' });
    expect(within(kenntnis).getAllByRole('row')[1]!.textContent).toContain('Murat Yilmaz');
    // Freigabestände und Meldewege aus dem Kontext.
    const staende = screen.getByRole('region', { name: 'Freigabestände' });
    expect(staende.textContent).toContain('Version 1.1');
    expect(staende.textContent).toContain('Version 1.0');
    const kultur = screen.getByRole('region', { name: 'Kultur und Meldewege' });
    expect(kultur.textContent).toContain('2 Meldungen aus dem Portal');
    expect(kultur.textContent).toContain('Jana Weller (Gesetzliche Vertretung)');
  });

  it('Neu adressieren: Beschreibung nur an gesetzliche Vertretung, Kenntnisnahme an alle Rollen', async () => {
    daten();
    await rendern();
    const knoepfe = screen.getAllByRole('button', { name: /Neu adressieren/ });
    expect(knoepfe).toHaveLength(2);

    fireEvent.click(within(screen.getByRole('table', { name: 'Freigaben' })).getByRole('button'));
    let dialog = screen.getByRole('dialog');
    let auswahl = within(dialog).getByRole('combobox', {
      name: 'Empfänger (gesetzliche Vertretung)',
    });
    expect([...auswahl.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Bitte wählen …',
      'Jana Weller (bisher)',
    ]);
    expect((dialog.querySelector('input[name="freigabeId"]') as HTMLInputElement).value).toBe(
      'cmvf9k8nd0095g87dk8fp5l35',
    );
    expect(dialog.textContent).toContain('Ein bereits ausgestellter Code verfällt');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abbrechen' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(
      within(screen.getByRole('table', { name: 'Kenntnisnahmen' })).getByRole('button'),
    );
    dialog = screen.getByRole('dialog');
    auswahl = within(dialog).getByRole('combobox', { name: 'Empfänger (Kontakt mit Rolle)' });
    expect([...auswahl.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Bitte wählen …',
      'Jana Weller',
      'Murat Yilmaz (bisher)',
      'Sabine Kraus',
    ]);
  });

  it('ohne gesetzliche Vertretung: Neu adressieren gesperrt mit Grund', async () => {
    const { kontext } = daten();
    kontext.kontaktRollen = kontext.kontaktRollen.filter(
      (r) => r.rolle !== 'GESETZLICHER_VERTRETER',
    );
    await rendern();
    const knopf = within(screen.getByRole('table', { name: 'Freigaben' })).getByRole('button');
    expect(knopf).toHaveProperty('disabled', true);
    expect(document.getElementById(knopf.getAttribute('aria-describedby')!)!.textContent).toContain(
      'Keine gesetzliche Vertretung',
    );
  });

  it.each([
    ['ohne Bearbeitungsrecht', { rechte: false, historisch: false, status: 'OFFEN' }],
    ['historischer Stand', { rechte: true, historisch: true, status: 'OFFEN' }],
    ['erledigte Anforderung', { rechte: true, historisch: false, status: 'FREIGEGEBEN' }],
  ] as const)('%s: kein „Neu adressieren“', async (_n, f) => {
    const { kontext, historie } = daten();
    kontext.rechte.bearbeiten = f.rechte;
    historie.historisch = f.historisch;
    for (const x of historie.freigaben) {
      x.status = f.status;
      if (f.status !== 'OFFEN') x.erledigtAm = '2026-10-01T10:00:00.000Z';
    }
    await rendern();
    expect(screen.queryAllByRole('button', { name: /Neu adressieren/ })).toHaveLength(0);
  });

  it('Zustellstatus je Anforderung: zugestellt, unzustellbar mit Grund, verworfen', async () => {
    const { historie } = daten();
    const [kenntnis, beschreibung] = historie.freigaben;
    kenntnis!.zustellung = {
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: '2026-10-01T08:00:00.000Z',
      status: 'ZUGESTELLT',
      am: '2026-10-01T08:05:00.000Z',
    };
    beschreibung!.zustellung = {
      zweck: 'FREIGABE_CODE',
      erstelltAm: '2026-10-02T08:00:00.000Z',
      status: 'UNZUSTELLBAR',
      am: '2026-10-09T08:00:00.000Z',
      grund: 'KEIN_PORTALZUGANG',
    };
    await rendern();
    const freigabe = within(screen.getByRole('table', { name: 'Freigaben' }))
      .getAllByRole('row')
      .at(1)!;
    expect(freigabe.textContent).toContain('Nachricht unzustellbar');
    expect(freigabe.textContent).toContain('Bestätigungscode');
    expect(freigabe.textContent).toContain('Empfänger hat keinen bestätigten Portalzugang');
    expect(freigabe.textContent).toContain(
      'Die Person hat die Anforderung nicht erhalten. Bitte neu adressieren.',
    );
    expect(within(freigabe).getByRole('button', { name: /Neu adressieren/ })).toBeTruthy();
    const zugestellt = within(screen.getByRole('table', { name: 'Kenntnisnahmen' }))
      .getAllByRole('row')
      .at(1)!;
    expect(zugestellt.textContent).toContain('Nachricht zugestellt');
    expect(zugestellt.textContent).not.toContain('nicht erhalten');
  });

  it('verworfen ohne Bearbeitungsrecht: Status und Hinweis, aber keine Aufforderung', async () => {
    const { kontext, historie } = daten();
    kontext.rechte.bearbeiten = false;
    historie.freigaben[1]!.zustellung = {
      zweck: 'FREIGABE_NEU_ADRESSIERT',
      erstelltAm: '2026-10-02T08:00:00.000Z',
      status: 'VERWORFEN',
      am: '2026-10-03T08:00:00.000Z',
    };
    await rendern();
    const zeile = within(screen.getByRole('table', { name: 'Freigaben' }))
      .getAllByRole('row')
      .at(1)!;
    expect(zeile.textContent).toContain('Nachricht nicht ausgeliefert');
    expect(zeile.textContent).toContain('Code galt nicht mehr');
    expect(zeile.textContent).toContain('Die Person hat die Anforderung nicht erhalten.');
    expect(zeile.textContent).not.toContain('Bitte neu adressieren');
    expect(within(zeile).queryByRole('button')).toBeNull();
  });

  it('erledigte Anforderung mit unzustellbarer Nachricht: Status, kein Hinweis', async () => {
    const { historie } = daten();
    const f = historie.freigaben[1]!;
    f.status = 'FREIGEGEBEN';
    f.erledigtAm = '2026-10-05T10:00:00.000Z';
    f.zustellung = {
      zweck: 'FREIGABE_ANGEFORDERT',
      erstelltAm: '2026-10-02T08:00:00.000Z',
      status: 'UNZUSTELLBAR',
      am: '2026-10-03T08:00:00.000Z',
      grund: 'SONSTIGES',
    };
    await rendern();
    const zeile = within(screen.getByRole('table', { name: 'Freigaben' }))
      .getAllByRole('row')
      .at(1)!;
    expect(zeile.textContent).toContain('Nachricht unzustellbar');
    expect(zeile.textContent).not.toContain('nicht erhalten');
  });

  it('Stichtag geht an beide Abfragen; Verweise behalten ihn', async () => {
    const { kontext } = daten();
    Object.assign(kontext, { historisch: true, stand: '2026-09-30' });
    await rendern({ stand: '2026-09-30' });
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: { stand: '2026-09-30' } });
    expect(h.lesen.mock.calls[0]![2]).toEqual({ query: { stand: '2026-09-30' } });
    const staende = screen.getByRole('region', { name: 'Freigabestände' });
    for (const a of within(staende).getAllByRole('link')) {
      expect(a.getAttribute('href')).toBe(`${BASIS}/beschreibung?stand=2026-09-30`);
    }
  });

  it.each(["2026-02-30' OR 1", '30.09.2026', ''])(
    'ungültiger Stichtag „%s“: Abfragen ohne Stichtag',
    async (stand) => {
      daten();
      await rendern({ stand });
      expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: {} });
      expect(h.lesen.mock.calls[0]![2]).toEqual({ query: {} });
    },
  );

  it('ohne Programm: kein Abruf der Freigaben', async () => {
    const { kontext } = daten();
    kontext.programm = null;
    await rendern();
    expect(
      screen.getByText('Für diesen Mandanten ist noch kein Tax-CMS eingerichtet.'),
    ).toBeTruthy();
    expect(h.lesen).not.toHaveBeenCalled();
  });
});
