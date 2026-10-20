// @vitest-environment jsdom
// TCMS Stufe 3, Bereich D: Ereigniseingang und Triage als Render-Test mit
// Antworten des Dienstes (Demo: Talwind, 2026-T-0345 als Portal-Meldung).
// Schutzregeln der Anzeige:
//   - Vier-Augen beim Verwerfen: Wer den Antrag gestellt hat, sieht kein
//     „Verwerfen bestätigen“, nur „Antrag zurückziehen“ (entscheiden tut der
//     Dienst; die Aktion bildet seine Ablehnung ab).
//   - Ohne Bearbeitungsrecht laut Kontext bzw. zum historischen Stichtag:
//     Aktionen gesperrt mit sichtbarem Grund.
//   - Anlagen nur über den Abruf mit Hash; Hinweise nur für bekannte Codes.
//   - Ungeklärte Anlagen aus Portal-Meldungen (kk-tcms-s10nach) aus der
//     kanzleikonsole: sichtbar mit Hinweis, zuordnen nur Admins/Partner, nur zu
//     einem Ereignis aus der Liste, nie freigeben.
// Fachkatalog: TCMS-DIENST-001
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  lesenOptional: vi.fn(),
  namen: vi.fn(),
  tenantLesen: vi.fn(),
  personen: vi.fn(),
  ungeklaert: vi.fn(),
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
vi.mock('@/server/tcms/portal/meldevorgang', () => ({
  ungeklaerteMeldungsAnlagenTx: h.ungeklaert,
}));
vi.mock('../ereignisse/actions', async (original) => ({
  ...(await original<typeof import('../ereignisse/actions')>()),
  ungeklaerteAnlageZuordnenAction: vi.fn(),
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
import { erwarteIsoliert, MARKE, markiert } from '@/__tests__/tcms-isolation';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsEreignissePage from '../ereignisse/page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const SEITE = {
  ok: true,
  art: 'MANDANT',
  session: { user: { tenantId: DEMO.tenant, staffId: DEMO.leon } },
  akteur: {},
  mandantId: DEMO.talwind,
  mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
  basis: BASIS,
};
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'StB Dr. Anna Roth',
  [DEMO.leon]: 'Leon Brandt',
  [DEMO.murat]: 'Murat Aydin',
};
const PERSONEN = {
  optionen: [
    { wert: `K:${DEMO.leon}`, label: 'Leon Brandt (Kanzlei)' },
    { wert: `M:${DEMO.murat}`, label: 'Murat Aydin (Mandant)' },
  ],
  berufstraeger: `K:${DEMO.anna}`,
  hauptbearbeitung: `K:${DEMO.leon}`,
};
const BEGRUENDUNG = 'Doppelte Meldung, bereits als 2026-T-0342 in Bearbeitung genommen.';

let kontext = tcmsFixtures.kontextTalwind();
let ereignis = tcmsFixtures.ereignis0345();

function seite(sp: Record<string, string> = {}) {
  return renderServer(
    TcmsEreignissePage({
      params: Promise.resolve({ id: DEMO.talwind }),
      searchParams: Promise.resolve(sp),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  kontext = tcmsFixtures.kontextTalwind();
  ereignis = tcmsFixtures.ereignis0345();
  h.seite.mockResolvedValue(SEITE);
  h.lesenOptional.mockImplementation(async (_s, e: { name: string }) => ({
    ok: true,
    daten: e.name === 'kontextLesen' ? kontext : tcmsFixtures.ereignisseTalwind(),
    requestId: 'r',
  }));
  h.lesen.mockImplementation(async () => ({ ok: true, daten: ereignis, requestId: 'r' }));
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  h.personen.mockReturnValue(PERSONEN);
  h.ungeklaert.mockResolvedValue([]);
  // Zwei Lesungen aus der kanzleikonsole: ungeklärte Anlagen (Funktion gemockt,
  // berührt die Transaktion nicht) und die Personenauswahl (feste Antwort).
  h.tenantLesen.mockImplementation(async (_s, fn: (tx: unknown) => Promise<unknown>) => {
    const keineTx = new Proxy(
      {},
      {
        get: () => {
          throw new Error('KEINE_TX');
        },
      },
    );
    try {
      return await fn(keineTx);
    } catch {
      return h.personen();
    }
  });
});

describe('Ereigniseingang', () => {
  it('Liste und Triage des ersten neuen Ereignisses; Vorschläge mit Zuständigkeit aus der kanzleikonsole', async () => {
    await seite();
    expect(h.lesen).toHaveBeenCalledWith(
      SEITE,
      expect.objectContaining({ name: 'ereignisLesen' }),
      { params: { ereignisId: ereignis.id }, query: {} },
    );
    expect(screen.getAllByText('2026-T-0345').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2026-T-0342').length).toBeGreaterThan(0);
    for (const f of ereignis.folgen) expect(screen.getByText(f.text)).toBeTruthy();
    const vorschlaege = document.querySelectorAll<HTMLInputElement>('input[name="folge"]');
    expect([...vorschlaege].map((c) => c.value)).toEqual(ereignis.folgen.map((f) => f.id));
    // Zuständigkeit: nur Personen aus der Auswahl der kanzleikonsole.
    const optionen = screen
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'))
      .filter((v) => v?.startsWith('K:') || v?.startsWith('M:'));
    expect(new Set(optionen)).toEqual(new Set([`K:${DEMO.leon}`, `M:${DEMO.murat}`]));
    expect(screen.getByRole('button', { name: 'In Prüfung nehmen' })).toBeTruthy();
  });

  it('Auswahl nur aus der Liste; unbekannte ID → erstes offenes Ereignis', async () => {
    await seite({ e: 'cmvf9ned0008hdy7dfremd0000' });
    expect(h.lesen).toHaveBeenCalledWith(SEITE, expect.anything(), {
      params: { ereignisId: ereignis.id },
      query: {},
    });
  });

  it('Vier-Augen: eigener Antrag ohne „Verwerfen bestätigen“, nur Zurückziehen', async () => {
    ereignis.verwerfenAntrag = {
      vonId: DEMO.leon,
      am: '2026-10-19T09:00:00.000Z',
      begruendung: BEGRUENDUNG,
    };
    await seite();
    expect(screen.queryByRole('button', { name: 'Verwerfen bestätigen' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Antrag zurückziehen' })).toBeTruthy();
    expect(screen.getByText(/zweite Person erfolgen/)).toBeTruthy();
  });

  it('Vier-Augen: Antrag einer anderen Person kann bestätigt oder abgelehnt werden', async () => {
    ereignis.verwerfenAntrag = {
      vonId: DEMO.anna,
      am: '2026-10-19T09:00:00.000Z',
      begruendung: BEGRUENDUNG,
    };
    ereignis.rechte.verwerfen.bestaetigen = { erlaubt: true, verweigerung: null };
    await seite();
    expect(
      (screen.getByRole('button', { name: 'Verwerfen bestätigen' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByRole('button', { name: 'Ablehnen' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Antrag zurückziehen' })).toBeNull();
  });

  it('Rechte am Ereignis (TCMS s7): gesperrt sichtbar mit dem festen Text zum Grund des Dienstes', async () => {
    const knopf = (name: string | RegExp) =>
      screen.getByRole('button', { name }) as HTMLButtonElement;
    const grund = (b: HTMLButtonElement) =>
      document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    // Fixture (Anna, NEU): abschließen nur am Zustand gescheitert, beantragen erlaubt.
    await seite();
    expect(knopf('Ereignis abschließen').disabled).toBe(true);
    expect(grund(knopf('Ereignis abschließen'))).toContain('Erst wenn jede Folge erledigt');
    expect(knopf('Verwerfen …').disabled).toBe(false);

    // Verweigerung der Person: fester Text zum Grund, nie ein Text des Dienstes.
    document.body.innerHTML = '';
    ereignis.rechte.abschliessen = { erlaubt: false, verweigerung: 'BEARBEITEN' };
    ereignis.rechte.verwerfen.beantragen = { erlaubt: false, verweigerung: 'BEARBEITEN' };
    ereignis.verwerfenAntrag = {
      vonId: DEMO.anna,
      am: '2026-10-19T09:00:00.000Z',
      begruendung: BEGRUENDUNG,
    };
    ereignis.rechte.verwerfen.bestaetigen = { erlaubt: false, verweigerung: 'VIER_AUGEN' };
    await seite();
    expect(knopf('Ereignis abschließen').disabled).toBe(true);
    expect(grund(knopf('Ereignis abschließen'))).toBe(TCMS_KEIN_RECHT.BEARBEITEN);
    expect(knopf('Verwerfen bestätigen').disabled).toBe(true);
    expect(grund(knopf('Verwerfen bestätigen'))).toBe(TCMS_KEIN_RECHT.VIER_AUGEN);

    // Erlaubt laut Dienst: frei, auch wenn die Vorschau der Domain anders aussähe.
    document.body.innerHTML = '';
    ereignis.verwerfenAntrag = null;
    ereignis.rechte.abschliessen = { erlaubt: true, verweigerung: null };
    ereignis.rechte.verwerfen.beantragen = { erlaubt: false, verweigerung: 'BEARBEITEN' };
    await seite();
    expect(knopf('Ereignis abschließen').disabled).toBe(false);
    expect(knopf('Verwerfen …').disabled).toBe(true);
  });

  it('ohne Bearbeitungsrecht laut Kontext: Aktionen gesperrt mit Grund, keine Personenabfrage', async () => {
    kontext.rechte.bearbeiten = false;
    await seite();
    const knopf = screen.getByRole('button', { name: 'In Prüfung nehmen' }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(screen.getAllByText(TCMS_KEIN_RECHT.BEARBEITEN).length).toBeGreaterThan(0);
    expect(h.personen).not.toHaveBeenCalled();
  });

  it('Anlagen über den Abruf mit Hash; Hinweis nur für bekannte Codes', async () => {
    const sha = 'ab'.repeat(32);
    ereignis.anlagen = [
      { dateiname: 'Bescheid.pdf', mime: 'application/pdf', groesse: 2048, sha256: sha },
    ];
    await seite({ anlage: 'abweichend' });
    const link = screen.getByRole('link', { name: /Bescheid\.pdf/ });
    expect(link.getAttribute('href')).toBe(
      `/api${BASIS}/ereignisse/anlage?e=${encodeURIComponent(ereignis.id)}&h=${sha}`,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/SHA-256/);

    document.body.innerHTML = '';
    await seite({ anlage: 'constructor' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Mandant noch nicht im Tax-CMS: Hinweis statt Liste', async () => {
    h.lesenOptional.mockResolvedValue({ ok: true, daten: null, requestId: 'r' });
    await seite();
    expect(screen.getByText(/noch kein Tax-CMS eingerichtet/)).toBeTruthy();
    expect(h.lesen).not.toHaveBeenCalled();
  });

  it('erledigtes Ereignis: Verlauf und Abschluss, keine Vorschlagsauswahl', async () => {
    ereignis = tcmsFixtures.ereignis0329();
    await seite({ e: ereignis.id });
    const panel = screen.getAllByRole('region').find((r) => within(r).queryByText(ereignis.titel));
    expect(panel).toBeTruthy();
    expect(document.querySelectorAll('input[name="folge"]')).toHaveLength(0);
  });
});

// kk-tcms-qual (s9-Rest): Titel, Beschreibung, Anlagen, Vorschläge, Folgen und
// Verlauf der Ereignisse mit Richtungsmarken bleiben isoliert.
describe('Ereigniseingang – Richtungsisolation', () => {
  it.each([
    ['neues Ereignis (Portal-Meldung)', () => tcmsFixtures.ereignis0345()],
    ['erledigtes Ereignis', () => tcmsFixtures.ereignis0329()],
  ])('%s: Liste und Detail isoliert', async (_fall, fixture) => {
    kontext = markiert(kontext, ENDPUNKTE.kontextLesen.antwortSchema);
    const liste = markiert(
      tcmsFixtures.ereignisseTalwind(),
      ENDPUNKTE.ereignisseLesen.antwortSchema,
    );
    ereignis = markiert(fixture(), ENDPUNKTE.ereignisLesen.antwortSchema);
    h.lesenOptional.mockImplementation(async (_s, e: { name: string }) => ({
      ok: true,
      daten: e.name === 'kontextLesen' ? kontext : liste,
      requestId: 'r',
    }));
    const { container } = await seite({ e: ereignis.id });
    erwarteIsoliert(container, 3);
  });

  it('Anlagen: Dateiname bereinigt (RT3B-K-04) und isoliert', async () => {
    ereignis.anlagen = [
      {
        dateiname: `${MARKE}Bescheid.pdf${MARKE}`,
        mime: 'application/pdf',
        groesse: 2048,
        sha256: 'cd'.repeat(32),
      },
    ];
    await seite();
    // Die Zeichenregel nimmt die Marke heraus; der Name steht trotzdem in <bdi>.
    expect(document.body.innerHTML).not.toContain(MARKE);
    const orte = screen.getAllByText('Bescheid.pdf');
    expect(orte.length).toBeGreaterThan(0);
    for (const ort of orte) expect(ort.tagName).toBe('BDI');
  });
});

describe('Ungeklärte Anlagen aus Portal-Meldungen (kk-tcms-s10nach)', () => {
  const ANLAGE = {
    verknuepfungId: '0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d',
    mandantId: DEMO.talwind,
    dokumentId: '5f0c7a1b-8e2d-4c3f-a1b0-9d8e7f6a5b4c',
    titel: 'Kassenbericht Oktober.csv',
    seit: new Date('2026-10-19T08:30:00Z'),
    kontaktId: DEMO.murat,
  };

  it('nur dieser Mandant; ohne ungeklärte Anlagen kein Abschnitt', async () => {
    await seite();
    expect(h.ungeklaert).toHaveBeenCalledWith(expect.anything(), {
      tenantId: DEMO.tenant,
      mandantIds: [DEMO.talwind],
    });
    expect(screen.queryByText('Ungeklärte Anlagen aus Portal-Meldungen')).toBeNull();
  });

  it('sichtbar mit Hinweis und meldender Person; Zuordnen nur für Admins/Partner', async () => {
    h.ungeklaert.mockResolvedValue([ANLAGE]);
    await seite();
    const abschnitt = screen
      .getByText('Ungeklärte Anlagen aus Portal-Meldungen')
      .closest('section') as HTMLElement;
    expect(within(abschnitt).getByText('Kassenbericht Oktober.csv')).toBeTruthy();
    expect(within(abschnitt).getByText(/gemeldet von Murat Aydin/)).toBeTruthy();
    expect(within(abschnitt).getByText(/nicht innerhalb von 23 Stunden bestätigt/)).toBeTruthy();
    const knopf = within(abschnitt).getByRole('button', {
      name: 'Ereignis zuordnen',
    }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(true);
    expect(
      within(abschnitt).getByText('Ungeklärte Anlagen ordnen Admins und Partner der Kanzlei zu.'),
    ).toBeTruthy();
    // Keine Freigabe aus der Oberfläche.
    expect(within(abschnitt).queryByRole('button', { name: /freigeben/i })).toBeNull();
  });

  it('Admin: Auswahl nur aus den Ereignissen der Liste', async () => {
    h.ungeklaert.mockResolvedValue([ANLAGE]);
    h.seite.mockResolvedValue({
      ...SEITE,
      session: { user: { ...SEITE.session.user, roles: ['ADMIN'] } },
    });
    await seite();
    const abschnitt = screen
      .getByText('Ungeklärte Anlagen aus Portal-Meldungen')
      .closest('section') as HTMLElement;
    const knopf = within(abschnitt).getByRole('button', {
      name: 'Ereignis zuordnen',
    }) as HTMLButtonElement;
    expect(knopf.disabled).toBe(false);
    fireEvent.click(knopf);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/gleicher SHA-256, gleiches Dokument/)).toBeTruthy();
    const optionen = [
      ...dialog.querySelectorAll<HTMLOptionElement>('select[name="ereignisId"] option'),
    ]
      .map((o) => o.value)
      .filter(Boolean);
    expect(optionen).toEqual(tcmsFixtures.ereignisseTalwind().ereignisse.map((x) => x.id));
  });
});
