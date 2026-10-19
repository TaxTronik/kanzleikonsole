// @vitest-environment jsdom
// TCMS Stufe 3, Bereich C: Feststellungen (Liste und Detail) als Render-Tests
// mit Antworten des Dienstes (src/__tests__/tcms-fixtures). Seiten-Helfer und
// Aktionen sind gemockt. Schwerpunkte: maskierte vertrauliche Feststellungen
// ohne geratene Felder (RT-01), §-153-Würdigung mit vier gleichrangigen
// Optionen ohne Vorauswahl, sichtbare Sperren nach den Kennzeichen des Dienstes.
// Fachkatalog: TCMS-DIENST-001
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
vi.mock('../actions', () => ({
  erklaerungAction: h.aktion(),
  feststellungErfassenAction: h.aktion(),
  feststellungWeiterAction: h.aktion(),
  massnahmeAnlegenAction: h.aktion(),
  massnahmeErledigenAction: h.aktion(),
  nachkontrolleAction: h.aktion(),
  p153EntscheidenAction: h.aktion(),
  verwerfenAblehnenAction: h.aktion(),
  verwerfenBeantragenAction: h.aktion(),
  verwerfenBestaetigenAction: h.aktion(),
  vertraulichAction: h.aktion(),
  wuerdigungAction: h.aktion(),
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsFeststellungenPage from '../page';
import TcmsFeststellungPage from '../[fid]/page';

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
const VERTRAULICHER_TITEL = 'Erstattungen FR/IT';

let kontext = tcmsFixtures.kontextTalwind();

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwind();
  h.seite.mockResolvedValue(seiteVon(DEMO.anna));
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  h.tenantLesen.mockResolvedValue([
    [`KANZLEI:${DEMO.leon}`, 'Leon Brandt (Kanzlei)'],
    [`MANDANT:${DEMO.jana}`, 'Jana Talwind (Mandant)'],
  ]);
});

function liste(daten: unknown, suche: Record<string, string> = {}) {
  h.lesenOptional.mockImplementation(async (_s: unknown, endpunkt: { name: string }) => ({
    ok: true,
    daten: endpunkt.name === 'kontextLesen' ? kontext : daten,
    requestId: 'r',
  }));
  return renderServer(
    TcmsFeststellungenPage({
      params: Promise.resolve({ id: DEMO.talwind }),
      searchParams: Promise.resolve(suche),
    }),
  );
}

function detail(daten: unknown, fid = 'cmvf9q0c40082fu7dh1ef2q31') {
  h.lesen.mockResolvedValue({ ok: true, daten, requestId: 'r' });
  h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: 'r' });
  return renderServer(
    TcmsFeststellungPage({
      params: Promise.resolve({ id: DEMO.talwind, fid }),
      searchParams: Promise.resolve({}),
    }),
  );
}

describe('Feststellungen – Liste', () => {
  it('zeigt Feststellungen über FeststellungBezeichnung mit Status, §-153-Stand und offenen Maßnahmen', async () => {
    await liste(tcmsFixtures.feststellungenTalwind());
    expect(
      screen.getByRole('heading', { level: 2, name: 'Feststellungen und Maßnahmen' }),
    ).toBeTruthy();
    const karte = screen.getByRole('region', { name: 'Feststellungen' });
    const link = within(karte).getByRole('link', { name: /F-2026-007 · Lager CZ/ });
    expect(link.getAttribute('href')).toBe(`${BASIS}/feststellungen/cmvf9q0c40082fu7dh1ef2q31`);
    expect(within(karte).getAllByText('Würdigung offen').length).toBeGreaterThan(0);
    const massnahmen = screen.getByRole('region', { name: 'Offene Maßnahmen' });
    expect(within(massnahmen).getAllByRole('row').length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: /Feststellung erfassen/ })).toBeTruthy();
  });

  it('maskierte vertrauliche Feststellung: nur Nummer, Status, Hinweis – kein Titel, keine Maßnahmeninhalte', async () => {
    h.seite.mockResolvedValue(seiteVon(DEMO.thomas));
    const daten = tcmsFixtures.feststellungenTalwindThomas();
    const maskiert = daten.feststellungen.find((f) => f.maskiert)!;
    // Eine offene Wiedervorlage der maskierten Feststellung (ohne Inhalt).
    maskiert.massnahmen[0]!.status = 'OFFEN';
    const { container } = await liste(daten);
    const karte = screen.getByRole('region', { name: 'Feststellungen' });
    expect(
      within(karte).getByRole('link', { name: 'F-2026-006 · Vertrauliche Feststellung' }),
    ).toBeTruthy();
    expect(container.textContent).not.toContain(VERTRAULICHER_TITEL);
    const massnahmen = screen.getByRole('region', { name: 'Offene Maßnahmen' });
    const zeile = within(massnahmen)
      .getAllByRole('row')
      .find((r) => r.textContent?.includes('F-2026-006'))!;
    const zellen = within(zeile).getAllByRole('cell');
    expect(zellen[1]!.textContent).toBe('vertraulich');
    expect(zellen[3]!.textContent).toBe('—');
    expect(h.namen.mock.calls[0]![1]).not.toContain(undefined);
  });

  it('Filter per GET: offen blendet geschlossene aus; maskierte fallen bei Klassenfilter heraus', async () => {
    await liste(tcmsFixtures.feststellungenTalwind(), { status: 'offen' });
    const karte = screen.getByRole('region', { name: 'Feststellungen' });
    expect(within(karte).queryByText(/F-2026-004/)).toBeNull();
    h.seite.mockResolvedValue(seiteVon(DEMO.thomas));
    await liste(tcmsFixtures.feststellungenTalwindThomas(), { klasse: 'STEUERLICHER_FEHLER' });
    const gefiltert = screen.getAllByRole('region', { name: 'Feststellungen' }).at(-1)!;
    expect(within(gefiltert).queryByText(/F-2026-006/)).toBeNull();
  });

  it('ohne Bearbeitungsrecht: Erfassen sichtbar gesperrt mit Grund', async () => {
    kontext.rechte = { bearbeiten: false, wuerdigen: false };
    await liste(tcmsFixtures.feststellungenTalwind());
    const knopf = screen.getByRole('button', {
      name: /Feststellung erfassen/,
    }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(knopf.title).toBe(TCMS_KEIN_RECHT.BEARBEITEN);
  });
});

describe('Feststellung – Detail', () => {
  it('§ 153: vier gleichrangige Optionen in fester Reihenfolge, keine vorausgewählt; Absenden erst mit Option und 30 Zeichen', async () => {
    await detail(tcmsFixtures.feststellungP153());
    const block = screen.getByRole('region', { name: /Würdigung durch Berufsträger erforderlich/ });
    const optionen = within(block).getAllByRole('radio') as HTMLInputElement[];
    expect(optionen.map((o) => o.value)).toEqual([
      'BERICHTIGUNG',
      'KEINE_PFLICHT',
      'WEITERE_KLAERUNG',
      'UEBERGABE',
    ]);
    expect(optionen.some((o) => o.checked)).toBe(false);
    const absenden = within(block).getByRole('button', { name: 'Entscheidung dokumentieren' });
    expect((absenden as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(optionen[2]!);
    expect((within(block).getByLabelText(/Klärung bis/) as HTMLInputElement).required).toBe(true);
    fireEvent.change(within(block).getByLabelText(/^Begründung/), { target: { value: 'zu kurz' } });
    expect((absenden as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(block).getByLabelText(/^Begründung/), {
      target: { value: 'Registrierungspflicht in CZ wird mit der Beraterin vor Ort geklärt.' },
    });
    expect((absenden as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(optionen[1]!);
    expect(
      (within(block).getByLabelText(/Frist für Berichtigung/) as HTMLInputElement).required,
    ).toBe(false);
  });

  it('§ 153 ohne Würdigungsrecht: sichtbar gesperrt mit Hinweis, Entscheidung beim Dienst', async () => {
    h.seite.mockResolvedValue(seiteVon(DEMO.leon));
    kontext.rechte = { bearbeiten: true, wuerdigen: false };
    await detail(tcmsFixtures.feststellungP153());
    const block = screen.getByRole('region', { name: /Würdigung durch Berufsträger erforderlich/ });
    expect(within(block).getByText(/Sie sind als Leon Brandt angemeldet/)).toBeTruthy();
    const feld = within(block).getByRole('group', { name: 'Ergebnis der §-153-Würdigung' });
    expect((feld as HTMLFieldSetElement).disabled).toBe(true);
    expect(feld.getAttribute('title')).toBe(TCMS_KEIN_RECHT.WUERDIGEN);
    // Vertraulich markieren ebenfalls nur mit Würdigungsrecht (Grund WUERDIGEN
    // wie im Dienst; VERTRAULICH steht für Nicht-Beteiligte).
    const vertraulich = screen.getByRole('button', {
      name: 'Vertraulich markieren',
    }) as HTMLButtonElement;
    expect(vertraulich.disabled).toBe(true);
    expect(vertraulich.title).toBe(TCMS_KEIN_RECHT.WUERDIGEN);
  });

  it('nächster Schritt als Vorschau: blockiert ohne §-153-Entscheidung', async () => {
    await detail(tcmsFixtures.feststellungP153());
    const weiter = screen.getByRole('button', { name: /Weiter zu „Maßnahmen offen“/ });
    expect((weiter as HTMLButtonElement).disabled).toBe(true);
    expect(weiter.getAttribute('title')).toBe(
      'Noch nicht möglich: §-153-Würdigung durch Berufsträger steht aus',
    );
  });

  it('Maßnahme: Verantwortliche nur aus der Auswahl der kanzleikonsole', async () => {
    await detail(tcmsFixtures.feststellungP153());
    expect(h.tenantLesen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '+ Maßnahme' }));
    const dialog = screen.getByRole('dialog');
    const auswahl = within(dialog).getByLabelText('Verantwortlich') as HTMLSelectElement;
    expect([...auswahl.options].map((o) => o.value)).toEqual([
      '',
      `KANZLEI:${DEMO.leon}`,
      `MANDANT:${DEMO.jana}`,
    ]);
  });

  it('Nachkontrolle und erledigte Maßnahmen mit Namen aus der kanzleikonsole', async () => {
    const { container } = await detail(
      tcmsFixtures.feststellungNachkontrolle(),
      'cmvf9q0bi007xfu7dqkshgfrc',
    );
    const nk = screen.getByRole('region', { name: 'Nachkontrolle' });
    expect(
      within(nk).getByRole('link', { name: /K-EC-04 · OSS-Abstimmung vor Abgabe/ }),
    ).toBeTruthy();
    expect(container.textContent).toContain('Entschieden: Berichtigung erforderlich');
    expect(container.textContent).toContain('StB Dr. Anna Roth');
    // Keine Personendaten aus dem Dienst: unbekannte IDs bleiben „Unbekannte Person“.
    expect(container.textContent).not.toContain('b1000000-0000-4000-8000');
  });

  it('Verwerfen beantragt: antragstellende Person bestätigt nicht (Vier-Augen-Anzeige)', async () => {
    const f = tcmsFixtures.feststellungP153();
    if (f.maskiert) throw new Error('Fixture');
    f.verwerfen = {
      begruendung: 'Doppelt erfasst, siehe F-2026-005 mit demselben Sachverhalt.',
      beantragtVon: DEMO.anna,
      bestaetigtVon: null,
    };
    await detail(f);
    const bestaetigen = screen.getByRole('button', { name: 'Verwerfen bestätigen' });
    expect((bestaetigen as HTMLButtonElement).disabled).toBe(true);
    expect(bestaetigen.getAttribute('title')).toBe(TCMS_KEIN_RECHT.VIER_AUGEN);
    expect(screen.getByRole('button', { name: 'Antrag zurückziehen' })).toBeTruthy();

    h.seite.mockResolvedValue(seiteVon(DEMO.leon));
    await detail(f);
    const zweite = screen.getAllByRole('button', { name: 'Verwerfen bestätigen' }).at(-1)!;
    expect((zweite as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByRole('button', { name: 'Ablehnen' }).length).toBe(1);
  });

  it('maskiert (Thomas): nur Nummer und Hinweis, keine Bedienung, keine Namen', async () => {
    h.seite.mockResolvedValue(seiteVon(DEMO.thomas));
    const { container } = await detail(
      tcmsFixtures.feststellungMaskiert(),
      'cmvf9q0bi007xfu7dqkshgfrc',
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'F-2026-006 · Vertrauliche Feststellung' }),
    ).toBeTruthy();
    expect(container.textContent).toContain('nur für Beteiligte sichtbar');
    expect(container.textContent).not.toContain(VERTRAULICHER_TITEL);
    expect(screen.queryAllByRole('button').filter((b) => b.textContent !== 'Anzeigen')).toEqual([]);
    expect(h.namen).not.toHaveBeenCalled();
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });

  it('historischer Stand: alle Bedienelemente gesperrt', async () => {
    kontext.historisch = true;
    await detail(tcmsFixtures.feststellungP153());
    expect((screen.getByRole('button', { name: '+ Maßnahme' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Feststellung verwerfen …' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });

  it('ungültige Feststellungs-ID: 404 ohne Dienstaufruf', async () => {
    await expect(detail({}, 'x/../y')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.lesen).not.toHaveBeenCalled();
  });
});
