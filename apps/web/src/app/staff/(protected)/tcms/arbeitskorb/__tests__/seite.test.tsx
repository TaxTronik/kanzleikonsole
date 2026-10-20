// @vitest-environment jsdom
// TCMS Stufe 3, Bereich C: Arbeitskorb als Render-Test mit Antworten des
// Dienstes (Demo-Daten). Einstieg tcmsKanzleiSeite (bestätigte
// Mandantenliste), Mandantennamen und Berufsträger aus der kanzleikonsole,
// Personennamen über tcmsNamenLesen; vertrauliche Feststellungen ohne Titel.
// Ungeklärte Anlagen aus Portal-Meldungen (kk-tcms-s10nach) aus der
// kanzleikonsole, nur für die Mandanten der bestätigten Liste, je Mandant.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  namen: vi.fn(),
  mandanten: vi.fn(),
  ungeklaert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/tcms/seite', () => ({
  tcmsKanzleiSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsNamenLesen: h.namen,
  tcmsTenantLesen: async (_s: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true }),
}));
vi.mock('@/server/tcms/portfolio', () => ({ portfolioMandanten: h.mandanten }));
vi.mock('@/server/tcms/portal/meldevorgang', () => ({
  ungeklaerteMeldungsAnlagenTx: h.ungeklaert,
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { erwarteIsoliert, markiert } from '@/__tests__/tcms-isolation';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import TcmsArbeitskorbPage from '../page';

const seiteVon = (staffId: string, bt: string[]) => ({
  ok: true,
  art: 'KANZLEI',
  session: { user: { tenantId: DEMO.tenant, staffId } },
  akteur: {},
  liste: {
    mandantIds: [DEMO.talwind, DEMO.seestern, DEMO.kleinwerk],
    bt,
    hb: [],
  },
});
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'StB Dr. Anna Roth',
  [DEMO.leon]: 'Leon Brandt',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(seiteVon(DEMO.anna, [DEMO.talwind, DEMO.seestern]));
  h.ungeklaert.mockResolvedValue([]);
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  // Namen der kanzleikonsole weichen bewusst vom Anker im Tax-CMS ab.
  h.mandanten.mockResolvedValue([
    {
      id: DEMO.talwind,
      name: 'Talwind (kk)',
      berufstraeger: ['StB Dr. Anna Roth'],
      zustaendig: true,
    },
    {
      id: DEMO.seestern,
      name: 'Seestern (kk)',
      berufstraeger: ['StB Thomas Kern'],
      zustaendig: true,
    },
    { id: DEMO.kleinwerk, name: 'Kleinwerk (kk)', berufstraeger: [], zustaendig: false },
  ]);
});

describe('Arbeitskorb', () => {
  it('liest mit der Kanzleiseite und zeigt Aufgaben mit Namen aus der kanzleikonsole', async () => {
    h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.arbeitskorbAnna(), requestId: 'r' });
    const { container } = await renderServer(TcmsArbeitskorbPage());
    expect(h.lesen).toHaveBeenCalledWith(
      expect.objectContaining({ art: 'KANZLEI' }),
      expect.objectContaining({ name: 'arbeitskorbLesen' }),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Arbeitskorb' })).toBeTruthy();
    const gegen = screen.getByRole('region', { name: 'Gegenzeichnungen' });
    expect(within(gegen).getAllByRole('link')).toHaveLength(3);
    expect(within(gegen).getAllByRole('link')[0]!.getAttribute('href')).toMatch(
      new RegExp(`^/staff/clients/${DEMO.talwind}/tcms/durchfuehrungen/`),
    );
    // Mandantennamen aus der kanzleikonsole, nie aus dem Dienst.
    expect(container.textContent).toContain('Talwind (kk)');
    expect(container.textContent).not.toContain('Talwind Outdoor GmbH');
    const p153 = screen.getByRole('region', { name: '§-153-Würdigungen' });
    // Der Titel steht richtungsisoliert in <bdi> (kk-tcms-qual): Abgleich auf die
    // ganze Bezeichnung statt auf einen einzelnen Textknoten.
    expect(
      within(p153).getAllByText((_, e) => /^F-2026-007 · Lager CZ/.test(e?.textContent ?? '')),
    ).not.toEqual([]);
  });

  it('vertrauliche Feststellung im Korb ohne Titel', async () => {
    const korb = tcmsFixtures.arbeitskorbAnna();
    const titel = korb.p153[1]!.titel;
    korb.p153[1]!.vertraulich = true;
    h.lesen.mockResolvedValue({ ok: true, daten: korb, requestId: 'r' });
    const { container } = await renderServer(TcmsArbeitskorbPage());
    const p153 = screen.getByRole('region', { name: '§-153-Würdigungen' });
    expect(within(p153).getByText('F-2026-007 · Vertrauliche Feststellung')).toBeTruthy();
    expect(container.textContent).not.toContain(titel);
  });

  it('ohne Würdigungsrecht: Hinweis auf offene Würdigungen mit Berufsträgern der kanzleikonsole', async () => {
    h.seite.mockResolvedValue(seiteVon(DEMO.leon, []));
    h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.arbeitskorbLeon(), requestId: 'r' });
    await renderServer(TcmsArbeitskorbPage());
    const hinweis = within(screen.getByRole('region', { name: '§-153-Würdigungen' })).getByRole(
      'note',
    );
    expect(hinweis.textContent).toContain('sind 2 §-153-Würdigungen');
    expect(hinweis.textContent).toContain('StB Thomas Kern, StB Dr. Anna Roth');
  });

  it('Zustand statt Daten, wenn die Seite nicht zugänglich ist', async () => {
    h.seite.mockResolvedValue({ ok: false, zustand: { art: 'NICHT_KONFIGURIERT' } });
    await renderServer(TcmsArbeitskorbPage());
    expect(screen.getByRole('status').textContent).toMatch(/nicht eingerichtet/);
    expect(h.lesen).not.toHaveBeenCalled();
  });
});

// kk-tcms-qual (s9-Rest): Aufgaben, Titel und Mandantenanker des Dienstes isoliert.
describe('Arbeitskorb – Richtungsisolation', () => {
  it.each([
    ['Anna', () => tcmsFixtures.arbeitskorbAnna()],
    ['Leon', () => tcmsFixtures.arbeitskorbLeon()],
  ])('Korb %s isoliert', async (_wer, korb) => {
    h.lesen.mockResolvedValue({
      ok: true,
      daten: markiert(korb(), ENDPUNKTE.arbeitskorbLesen.antwortSchema),
      requestId: 'r',
    });
    const { container } = await renderServer(TcmsArbeitskorbPage());
    erwarteIsoliert(container, 2);
  });
});

describe('Arbeitskorb – ungeklärte Anlagen aus Portal-Meldungen (kk-tcms-s10nach)', () => {
  const anlage = (mandantId: string, seit: string) => ({
    verknuepfungId: crypto.randomUUID(),
    mandantId,
    dokumentId: crypto.randomUUID(),
    titel: 'Kassenbericht.csv',
    seit: new Date(seit),
    kontaktId: DEMO.murat,
  });

  it('je Mandant gezählt (älteste zuerst), mit Link in den Ereigniseingang; nur Mandanten der Liste', async () => {
    h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.arbeitskorbAnna(), requestId: 'r' });
    h.ungeklaert.mockResolvedValue([
      anlage(DEMO.seestern, '2026-10-18T07:00:00Z'),
      anlage(DEMO.talwind, '2026-10-19T07:00:00Z'),
      anlage(DEMO.seestern, '2026-10-20T07:00:00Z'),
    ]);
    await renderServer(TcmsArbeitskorbPage());
    expect(h.ungeklaert).toHaveBeenCalledWith(
      { tx: true },
      { tenantId: DEMO.tenant, mandantIds: [DEMO.talwind, DEMO.seestern, DEMO.kleinwerk] },
    );
    const gruppe = screen.getByRole('region', { name: 'Ungeklärte Anlagen aus Portal-Meldungen' });
    const links = within(gruppe).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      `/staff/clients/${DEMO.seestern}/tcms/ereignisse`,
      `/staff/clients/${DEMO.talwind}/tcms/ereignisse`,
    ]);
    expect(links[0]!.textContent).toContain('Seestern (kk)');
    expect(links[0]!.textContent).toContain('2 Anlagen');
    expect(links[1]!.textContent).toContain('1 Anlage');
    // Titel und Personen der Anlagen erscheinen hier nicht (Detail im Ereigniseingang).
    expect(gruppe.textContent).not.toContain('Kassenbericht.csv');
  });

  it('ohne ungeklärte Anlagen keine Gruppe', async () => {
    h.lesen.mockResolvedValue({ ok: true, daten: tcmsFixtures.arbeitskorbAnna(), requestId: 'r' });
    await renderServer(TcmsArbeitskorbPage());
    expect(
      screen.queryByRole('region', { name: 'Ungeklärte Anlagen aus Portal-Meldungen' }),
    ).toBeNull();
  });
});
