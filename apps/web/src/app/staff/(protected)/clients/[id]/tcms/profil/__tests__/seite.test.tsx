// @vitest-environment jsdom
// TCMS Stufe 3, Bereich A: Geschäftsprofil als Render-Test mit Antworten des
// Dienstes (Demo-Mandant Talwind: zwei Profilstände, 22 Vorschläge). Die
// Seiten-Helfer sind gemockt; ihre Prüfkette testet
// server/tcms/__tests__/seite.test.ts. Geprüft wird: Stand zum Stichtag,
// Historie, Vorschläge in Abschnitten nach der Entscheidung des Dienstes,
// „Risiko aufnehmen“ nur mit Recht und passender Zuständigkeit, Meldungen aus
// der Weiterleitung nur nach strenger Prüfung.
// Fachkatalog: TCMS-DIENST-001
import { screen, within } from '@testing-library/react';
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
import { AUFNAHME_TEXTE } from '@/server/tcms/programm/zustaendigkeit';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsProfilPage from '../page';

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
  [DEMO.leon]: 'Leon Brandt',
  [DEMO.jana]: 'Jana Weller',
};
const ANNA = { id: DEMO.anna, name: 'StB Dr. Anna Roth' };
const LEON = { id: DEMO.leon, name: 'Leon Brandt' };
const ZUST = { berufstraeger: ANNA, bearbeitung: LEON, kanzlei: [ANNA, LEON], vertretung: null };

function daten() {
  const kontext = tcmsFixtures.kontextTalwind();
  const profil = tcmsFixtures.profilTalwind();
  h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: 'r' });
  h.lesen.mockResolvedValue({ ok: true, daten: profil, requestId: 'r' });
  return { kontext, profil };
}

async function rendern(sp: Record<string, string> = {}) {
  return renderServer(
    TcmsProfilPage({
      params: Promise.resolve({ id: DEMO.talwind }),
      searchParams: Promise.resolve(sp),
    }),
  );
}

/** Vorschläge: EC-UST-11 neu, EC-UST-12 begründet abgelehnt (nicht im Inventar). */
function mitOffenenVorschlaegen(d: ReturnType<typeof daten>) {
  for (const v of d.profil.vorschlaege) {
    if (v.code === 'EC-UST-11') Object.assign(v, { entscheidung: 'OFFEN', risikoId: null });
    if (v.code === 'EC-UST-12') v.entscheidung = 'ABGELEHNT';
  }
  const r12 = d.profil.risiken.find((r) => r.code === 'EC-UST-12')!;
  Object.assign(r12, { entscheidung: 'ABGELEHNT', ablehnungsgrund: 'Import nur über Händler' });
  d.kontext.risiken = d.kontext.risiken.filter((r) => !['EC-UST-11', 'EC-UST-12'].includes(r.code));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(SEITE);
  h.tenantLesen.mockResolvedValue(ZUST);
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
});

describe('Geschäftsprofil', () => {
  it('zeigt den gültigen Stand, die Historie und ein deckungsgleiches Inventar', async () => {
    daten();
    await rendern();
    const stand = screen.getByRole('region', { name: /Geschäftsprofil P1–P12/ });
    expect(stand.textContent).toContain('gültig ab 01.10.2026');
    expect(within(stand).getByText('aktuell')).toBeTruthy();
    expect(stand.textContent).toContain('Erfasst von Leon Brandt');

    const historie = screen.getByRole('region', { name: 'Historie' });
    const eintraege = [...historie.querySelectorAll<HTMLElement>('ol > li')];
    expect(eintraege.map((e) => e.querySelector('span')?.textContent)).toEqual([
      'Stand 2',
      'Stand 1',
    ]);
    expect(eintraege[0]!.getAttribute('aria-current')).toBe('true');
    expect(within(eintraege[1]!).getByText('abgelöst')).toBeTruthy();
    expect(
      within(eintraege[1]!)
        .getByRole('link', { name: 'Stand zum 30.09.2026 ansehen' })
        .getAttribute('href'),
    ).toBe(`${BASIS}/profil?stand=2026-09-30`);

    const vorschlag = screen.getByRole('region', { name: 'Risikovorschlag aus dem Profil' });
    expect(vorschlag.textContent).toContain('alle 22 Vorschläge sind im Inventar');
    expect(within(vorschlag).queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByRole('link', { name: /Profil ändern/ }).getAttribute('href')).toBe(
      `${BASIS}/profil?aendern=1#aendern`,
    );
    // Namen über die kanzleikonsole, einmal je Seite.
    expect(h.namen).toHaveBeenCalledOnce();
  });

  it('Vorschläge nach Entscheidung des Dienstes; „Aufnehmen“ mit dem Code als festem Wert', async () => {
    const d = daten();
    mitOffenenVorschlaegen(d);
    await rendern();
    const neu = screen.getByRole('region', { name: 'Neu vorgeschlagen' });
    const knopf = within(neu).getByRole('button', { name: /Risiko aufnehmen\s?\(EC-UST-11\)/ });
    expect(knopf).toHaveProperty('disabled', false);
    expect(
      (knopf.closest('form')!.querySelector('input[name="code"]') as HTMLInputElement).value,
    ).toBe('EC-UST-11');
    const abgelehnt = screen.getByRole('region', {
      name: 'Begründet abgelehnt, weiterhin vorgeschlagen',
    });
    expect(abgelehnt.textContent).toContain('Ablehnung: Import nur über Händler');
    expect(
      within(abgelehnt).getByRole('button', { name: /Doch aufnehmen\s?\(EC-UST-12\)/ }),
    ).toBeTruthy();
    expect(screen.queryByText(/deckungsgleich/)).toBeNull();
  });

  it.each([
    ['ohne Zuständigkeit', { ...ZUST, berufstraeger: null }, AUFNAHME_TEXTE.keineZustaendigkeit],
    ['gleiche Person', { ...ZUST, bearbeitung: ANNA }, AUFNAHME_TEXTE.gleichePerson],
  ])('„Aufnehmen“ gesperrt %s, mit sichtbarem Grund', async (_n, zust, text) => {
    const d = daten();
    mitOffenenVorschlaegen(d);
    h.tenantLesen.mockResolvedValue(zust);
    await rendern();
    const knopf = screen.getByRole('button', { name: /Risiko aufnehmen\s?\(EC-UST-11\)/ });
    expect(knopf).toHaveProperty('disabled', true);
    expect(document.getElementById(knopf.getAttribute('aria-describedby')!)!.textContent).toBe(
      text,
    );
  });

  it('ohne Bearbeitungsrecht: kein „Profil ändern“, „Aufnehmen“ gesperrt, keine Zuständigkeitsabfrage', async () => {
    const d = daten();
    mitOffenenVorschlaegen(d);
    d.kontext.rechte.bearbeiten = false;
    await rendern({ aendern: '1' });
    expect(screen.queryByRole('link', { name: /Profil ändern/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Profil ändern' })).toBeNull();
    expect(screen.getByRole('button', { name: /Risiko aufnehmen/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getAllByText(TCMS_KEIN_RECHT.BEARBEITEN).length).toBeGreaterThan(0);
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });

  it('historischer Stand: Stichtag an beide Abfragen, nur Lesen', async () => {
    const d = daten();
    Object.assign(d.kontext, { historisch: true, stand: '2026-09-30' });
    Object.assign(d.profil, { historisch: true, stand: '2026-09-30' });
    mitOffenenVorschlaegen(d);
    await rendern({ stand: '2026-09-30', aendern: '1', geaendert: '1' });
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: { stand: '2026-09-30' } });
    expect(h.lesen.mock.calls[0]![2]).toEqual({ query: { stand: '2026-09-30' } });
    const stand = screen.getByRole('region', { name: /Geschäftsprofil P1–P12/ });
    expect(stand.textContent).toContain('gültig ab 15.02.2026');
    expect(within(stand).getByText('Stand zum 30.09.2026')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Profil ändern/ })).toBeNull();
    expect(screen.queryByText(/Neuer Profilstand angelegt/)).toBeNull();
    expect(screen.getByRole('button', { name: /Risiko aufnehmen/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });

  it('ungültiger Stichtag: beide Abfragen ohne Stichtag', async () => {
    daten();
    await rendern({ stand: '2026-13-01' });
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: {} });
    expect(h.lesen.mock.calls[0]![2]).toEqual({ query: {} });
  });

  it('„Profil ändern“ öffnet das Formular auf Basis des offenen Stands', async () => {
    daten();
    await rendern({ aendern: '1' });
    const bereich = screen.getByRole('region', { name: 'Profil ändern' });
    expect(bereich.textContent).toContain('Basis: Stand gültig ab 01.10.2026 · Leon Brandt');
    expect((bereich.querySelector('input[name="profilStandId"]') as HTMLInputElement).value).toBe(
      'cmvf9k8fl007og87dilm7agso',
    );
  });

  it('Meldungen aus der Weiterleitung nur mit geprüften Werten', async () => {
    daten();
    const { container } = await rendern({
      aufgenommen: 'EC-UST-05',
      kn: 'K-EC-03,<script>,K-EC-04',
      vk: 'javascript:alert(1)',
      d: '7',
    });
    const meldung = within(
      screen.getByRole('region', { name: 'Risikovorschlag aus dem Profil' }),
    ).getByRole('status');
    expect(meldung.textContent).toContain('EC-UST-05 ins Risikoinventar aufgenommen');
    expect(meldung.textContent).toContain('Kontrollen angelegt: K-EC-03, K-EC-04');
    expect(meldung.textContent).toContain('7 Durchführungen geplant');
    expect(meldung.textContent).not.toContain('verknüpft');
    expect(container.innerHTML).not.toContain('<script>');

    await rendern({ aufgenommen: 'EC-UST-05<b>' });
    expect(screen.queryAllByText(/ins Risikoinventar aufgenommen/)).toHaveLength(1);
  });

  it('Erfolg „Profil geändert“ mit den Zahlen der Weiterleitung', async () => {
    daten();
    await rendern({ geaendert: '1', nb: '2', ev: '1', nv: 'x' });
    const meldung = screen.getAllByRole('status')[0]!;
    expect(meldung.textContent).toContain('Neuer Profilstand angelegt (gültig ab 01.10.2026)');
    expect(meldung.textContent).toContain('2 Risiko/Risiken zur Neubewertung markiert');
    expect(meldung.textContent).toContain('0 Vorschlag/Vorschläge');
  });

  it('ohne Version 1: Verweis auf den Einrichtungsassistenten, kein Profilabruf', async () => {
    const d = daten();
    d.kontext.programm!.version1Am = null;
    await rendern();
    expect(screen.getByRole('link', { name: 'Einrichtung fortsetzen' }).getAttribute('href')).toBe(
      `${BASIS}/einrichtung`,
    );
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('Mandant nicht im Tax-CMS bzw. Störung: Zustände statt Daten', async () => {
    h.lesenOptional.mockResolvedValue({ ok: true, daten: null, requestId: null });
    await rendern();
    expect(screen.getByRole('link', { name: 'Zum Cockpit' })).toBeTruthy();
    expect(h.lesen).not.toHaveBeenCalled();

    daten();
    h.lesen.mockResolvedValue({
      ok: false,
      zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-9' },
    });
    await rendern();
    expect(screen.getByRole('heading', { name: 'Tax-CMS derzeit nicht erreichbar' })).toBeTruthy();
  });
});
