// @vitest-environment jsdom
// TCMS Stufe 3: Cockpit und Kontakte & Rollen des Mandanten als Render-Tests
// mit Antworten des Dienstes (Demo-Daten, src/__tests__/tcms-fixtures).
// Die Seiten-Helfer sind gemockt; ihre Prüfkette testet
// server/tcms/__tests__/seite.test.ts.
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
import { erwarteIsoliert, markiert } from '@/__tests__/tcms-isolation';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { UNBEKANNTE_PERSON, KEINE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import TcmsCockpitPage from '../page';
import TcmsKontaktePage from '../kontakte/page';

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
const NAMEN: Record<string, string> = {
  [DEMO.anna]: 'StB Dr. Anna Roth',
  [DEMO.leon]: 'Leon Brandt',
  [DEMO.murat]: 'Murat Yilmaz',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(SEITE);
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
});

const params = Promise.resolve({ id: DEMO.talwind });

describe('Cockpit', () => {
  it('rendert das Cockpit mit maskierter vertraulicher Feststellung, ohne Felder zu erraten', async () => {
    const kontext = tcmsFixtures.kontextTalwind();
    h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: 'r' });
    const { container } = await renderServer(
      TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Cockpit' })).toBeTruthy();
    const karte = screen.getByRole('region', { name: 'Offene Feststellungen' });
    expect(within(karte).getByText('F-2026-006 · Vertrauliche Feststellung')).toBeTruthy();
    expect(within(karte).getByText(/Inhalt nur für Beteiligte sichtbar/)).toBeTruthy();
    // Der Titel der maskierten Feststellung steht nirgends (RT-01).
    expect(container.textContent).not.toContain('Erstattungen FR/IT');
    // §-153-Hinweis nur für die lesbare Feststellung.
    expect(screen.getByRole('alert').textContent).toContain('F-2026-007');
    expect(screen.getByRole('alert').textContent).not.toContain('F-2026-006');
    // Pflicht-Framing und Phase aus dem Dienst.
    expect(screen.getByRole('note').textContent).toContain('Angemessenheit und Wirksamkeit');
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain('6');
    // Lesen ohne Stichtag, Namen über die kanzleikonsole.
    expect(h.lesenOptional).toHaveBeenCalledWith(
      SEITE,
      expect.objectContaining({ name: 'kontextLesen' }),
      {
        query: {},
      },
    );
    expect(h.namen).toHaveBeenCalledOnce();
    const faellig = screen.getByRole('region', { name: 'Fällige Kontrollen' });
    expect(within(faellig).getAllByRole('row').length).toBeGreaterThan(1);
  });

  it('gibt nur einen gültigen Stichtag an den Dienst weiter', async () => {
    h.lesenOptional.mockResolvedValue({
      ok: true,
      daten: tcmsFixtures.kontextTalwind(),
      requestId: null,
    });
    await renderServer(
      TcmsCockpitPage({ params, searchParams: Promise.resolve({ stand: '2026-09-30' }) }),
    );
    expect(h.lesenOptional.mock.calls[0]![2]).toEqual({ query: { stand: '2026-09-30' } });
    await renderServer(
      TcmsCockpitPage({ params, searchParams: Promise.resolve({ stand: "x' OR 1" }) }),
    );
    expect(h.lesenOptional.mock.calls[1]![2]).toEqual({ query: {} });
  });

  it('Mandant nicht im Tax-CMS: Aktion „anlegen“ und Verweis auf die Einrichtung', async () => {
    h.lesenOptional.mockResolvedValue({ ok: true, daten: null, requestId: null });
    await renderServer(TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('button', { name: 'Mandant im Tax-CMS anlegen' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Einrichtung' }).getAttribute('href')).toBe(
      `${BASIS}/einrichtung`,
    );
    expect(h.namen).not.toHaveBeenCalled();
  });

  it('zeigt Zustände statt Daten (nicht eingerichtet, nicht erreichbar)', async () => {
    h.seite.mockResolvedValueOnce({ ok: false, zustand: { art: 'NICHT_KONFIGURIERT' } });
    await renderServer(TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Tax-CMS nicht eingerichtet' })).toBeTruthy();
    expect(h.lesenOptional).not.toHaveBeenCalled();
  });

  it('zeigt die requestId des Dienstes bei einer Störung', async () => {
    h.lesenOptional.mockResolvedValue({
      ok: false,
      zustand: { art: 'NICHT_ERREICHBAR', requestId: 'req-42' },
    });
    await renderServer(TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('heading', { name: 'Tax-CMS derzeit nicht erreichbar' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('req-42');
  });

  it('bietet den Abgleich an, wenn der Name im Tax-CMS von der Mandantenakte abweicht', async () => {
    const kontext = tcmsFixtures.kontextTalwind();
    kontext.mandant.name = 'Talwind Outdoor GmbH (alt)';
    h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: null });
    await renderServer(TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('button', { name: 'Stammdaten übernehmen' })).toBeTruthy();
  });

  it.each([
    ['ohne Recht', false, TCMS_KEIN_RECHT.BEARBEITEN],
    ['im historischen Stand', true, 'Übernehmen ist nur im aktuellen Stand möglich.'],
  ])(
    'Stammdaten abweichend %s: kein Abgleich, nur der feste Grund (mandant.rechte)',
    async (_fall, historisch, grund) => {
      const kontext = tcmsFixtures.kontextTalwind();
      kontext.mandant.name = 'Talwind Outdoor GmbH (alt)';
      kontext.mandant.rechte.bearbeiten = false;
      kontext.historisch = historisch;
      h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: null });
      await renderServer(TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }));
      expect(screen.queryByRole('button', { name: 'Stammdaten übernehmen' })).toBeNull();
      const hinweis = screen.getByText(
        'Die Stammdaten im Tax-CMS weichen von der Mandantenakte ab.',
      ).parentElement!;
      expect(hinweis.textContent).toContain(grund);
    },
  );

  it.each([true, false])(
    'ohne Programm: „Tax-CMS einrichten“ nur mit dem Bearbeitungsrecht des Dienstes (%s)',
    async (bearbeiten) => {
      const kontext = tcmsFixtures.kontextTalwind();
      kontext.programm = null;
      kontext.rechte.bearbeiten = bearbeiten;
      h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: null });
      const { container } = await renderServer(
        TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }),
      );
      const link = screen.queryByRole('link', { name: 'Tax-CMS einrichten' });
      expect(link !== null).toBe(bearbeiten);
      if (link) expect(link.getAttribute('href')).toBe(`${BASIS}/einrichtung`);
      expect(container.textContent?.includes(TCMS_KEIN_RECHT.BEARBEITEN)).toBe(!bearbeiten);
    },
  );
});

describe('Kontakte & Rollen', () => {
  const FREMD = '99999999-9999-4999-8999-999999999999';

  beforeEach(() => {
    const kontakte = tcmsFixtures.kontakteTalwind();
    // Eintrag des Dienstes ohne Kontakt dieses Mandanten (darf nicht erscheinen).
    kontakte.kontakte.push({
      kontaktId: FREMD,
      rollen: [{ rolle: 'GESETZLICHER_VERTRETER', aktiv: true, funktion: 'Fremd' }],
    });
    h.lesen.mockResolvedValue({ ok: true, daten: kontakte, requestId: null });
    h.tenantLesen.mockResolvedValue([
      {
        id: DEMO.jana,
        name: 'Jana Weller',
        email: 'jana@talwind.example',
        aktiv: true,
        funktion: null,
      },
      {
        id: DEMO.murat,
        name: 'Murat Yilmaz',
        email: 'murat@talwind.example',
        aktiv: false,
        funktion: null,
      },
      {
        id: 'c0000000-0000-4000-8000-000000000001',
        name: 'Neu Kontakt',
        email: 'neu@talwind.example',
        aktiv: true,
        funktion: 'Einkauf',
      },
    ]);
  });

  it('zeigt nur Kontakte dieses Mandanten mit ihren Rollen aus dem Tax-CMS', async () => {
    const { container } = await renderServer(TcmsKontaktePage({ params }));
    const zeilen = screen.getAllByRole('row').slice(1);
    expect(zeilen).toHaveLength(3);
    expect(within(zeilen[0]!).getByRole('listitem').textContent).toBe('Gesetzliche Vertretung');
    expect(within(zeilen[1]!).getByRole('listitem').textContent).toBe('Tax-Compliance-Beauftragte');
    expect(within(zeilen[1]!).getByText('inaktiv')).toBeTruthy();
    expect(within(zeilen[2]!).getByText('keine – kein Zugriff')).toBeTruthy();
    // Einträge ohne Kontakt dieses Mandanten (Sabine aus der Demo, FREMD):
    // nur gezählt, ohne ID oder Funktion.
    expect(screen.getByText(/2 Einträge im Tax-CMS gehören zu keinem Kontakt/)).toBeTruthy();
    expect(container.innerHTML).not.toContain(FREMD);
    expect(container.innerHTML).not.toContain(DEMO.sabine);
    expect(container.textContent).not.toContain('Fremd');
    // Rollenformular je Kontakt; inaktive Kontakte: nur Entfernen.
    const formular = within(zeilen[1]!).getByRole('form', { name: /Murat Yilmaz/ });
    const ohneRolle = within(formular).getByRole('checkbox', { name: 'Gesetzliche Vertretung' });
    expect((ohneRolle as HTMLInputElement).disabled).toBe(true);
    const mitRolle = within(formular).getByRole('checkbox', { name: 'Tax-Compliance-Beauftragte' });
    expect((mitRolle as HTMLInputElement).disabled).toBe(false);
    expect((mitRolle as HTMLInputElement).checked).toBe(true);
  });

  it('mit Recht laut Dienst: Formulare bedienbar, kein Sperrhinweis', async () => {
    const { container } = await renderServer(TcmsKontaktePage({ params }));
    expect(container.textContent).not.toContain(TCMS_KEIN_RECHT.BEARBEITEN);
    for (const formular of screen.getAllByRole('form', { name: /Tax-CMS-Rollen von/ })) {
      const knopf = within(formular).getByRole('button', { name: 'Rollen speichern' });
      expect((knopf as HTMLButtonElement).matches(':disabled')).toBe(false);
      expect(within(formular).getByLabelText('Funktion (optional)').matches(':disabled')).toBe(
        false,
      );
    }
  });

  it('ohne Recht laut Dienst (kontakte.rechte): Formulare sichtbar, aber gesperrt, mit Grund', async () => {
    const kontakte = tcmsFixtures.kontakteTalwind();
    kontakte.rechte.bearbeiten = false;
    h.lesen.mockResolvedValue({ ok: true, daten: kontakte, requestId: null });
    await renderServer(TcmsKontaktePage({ params }));
    const hinweis = screen.getByRole('note');
    expect(hinweis.textContent).toBe(`Rollen ändern: ${TCMS_KEIN_RECHT.BEARBEITEN}`);
    const formulare = screen.getAllByRole('form', { name: /Tax-CMS-Rollen von/ });
    expect(formulare).toHaveLength(3);
    for (const formular of formulare) {
      const knopf = within(formular).getByRole('button', { name: 'Rollen speichern' });
      expect((knopf as HTMLButtonElement).disabled).toBe(true);
      expect(knopf.getAttribute('title')).toBe(TCMS_KEIN_RECHT.BEARBEITEN);
      for (const feld of within(formular).getAllByRole('checkbox')) {
        expect(feld.matches(':disabled')).toBe(true);
      }
      expect(within(formular).getByLabelText('Funktion (optional)').matches(':disabled')).toBe(
        true,
      );
      const gruppe = within(formular).getByRole('group', { name: /^Rollen von / });
      expect(gruppe.getAttribute('aria-describedby')).toBe(hinweis.id);
    }
    // Aktive Rollen bleiben lesbar.
    expect(screen.getAllByRole('checkbox', { checked: true }).length).toBeGreaterThan(0);
  });

  it('liest Kontakte nur mit dem Mandanten der Seite', async () => {
    await renderServer(TcmsKontaktePage({ params }));
    const lesen = h.tenantLesen.mock.calls[0]![1] as (tx: unknown) => Promise<unknown>;
    const tx = { clientContact: { findMany: vi.fn(async () => []) } };
    await lesen(tx);
    expect(tx.clientContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: DEMO.tenant, clientId: DEMO.talwind } }),
    );
  });
});

// kk-tcms-qual (s9-Rest): Texte des Dienstes im Cockpit und in den
// Kontaktrollen (Funktion) mit Richtungsmarken bleiben isoliert.
describe('Cockpit und Kontakte – Richtungsisolation', () => {
  it('Cockpit', async () => {
    h.lesenOptional.mockResolvedValue({
      ok: true,
      daten: markiert(tcmsFixtures.kontextTalwind(), ENDPUNKTE.kontextLesen.antwortSchema),
      requestId: 'r',
    });
    const { container } = await renderServer(
      TcmsCockpitPage({ params, searchParams: Promise.resolve({}) }),
    );
    erwarteIsoliert(container, 5);
  });

  it('Kontakte & Rollen', async () => {
    h.lesen.mockResolvedValue({
      ok: true,
      daten: markiert(tcmsFixtures.kontakteTalwind(), ENDPUNKTE.kontakteLesen.antwortSchema),
      requestId: null,
    });
    h.tenantLesen.mockResolvedValue([
      {
        id: DEMO.jana,
        name: 'Jana Weller',
        email: 'jana@talwind.example',
        aktiv: true,
        funktion: null,
      },
    ]);
    const { container } = await renderServer(TcmsKontaktePage({ params }));
    erwarteIsoliert(container, 1);
  });
});
