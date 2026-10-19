// @vitest-environment jsdom
// TCMS Stufe 3, Bereich A: CMS-Beschreibung als Render-Test mit der Antwort
// des Dienstes (Demo-Mandant Talwind: v1.0 abgelöst, v1.1 freigegeben, v1.2
// beim Mandanten, v1.3 Entwurf). Die Seiten-Helfer sind gemockt; ihre
// Prüfkette testet server/tcms/__tests__/seite.test.ts. Geprüft wird:
// eingefrorene Versionen zeigen genau den eingefrorenen Inhalt mit Hash und
// bieten keine Bearbeitung an; lebende Bausteine zeigen Namen der
// kanzleikonsole; Aktionen je Status, Vier-Augen-Hinweis, Empfänger der
// Freigabe nur gesetzliche Vertretungen dieses Mandanten.
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
import TcmsBeschreibungPage from '../page';

const BASIS = `/staff/clients/${DEMO.talwind}/tcms`;
const V12 = 'cmvf9k8n20093g87donaw4i34';
const V13 = 'cmvf9k8n80094g87dcb19jjso';
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
  [DEMO.murat]: 'Murat Yilmaz',
};
const ZUST = {
  berufstraeger: { id: DEMO.anna, name: 'StB Dr. Anna Roth' },
  bearbeitung: { id: DEMO.leon, name: 'Leon Brandt' },
  kanzlei: [],
  vertretung: null,
};

function daten() {
  const kontext = tcmsFixtures.kontextTalwind();
  const b = tcmsFixtures.beschreibungTalwind();
  h.lesenOptional.mockResolvedValue({ ok: true, daten: kontext, requestId: 'r' });
  h.lesen.mockResolvedValue({ ok: true, daten: b, requestId: 'r' });
  return { kontext, b };
}

async function rendern(sp: Record<string, string> = {}) {
  return renderServer(
    TcmsBeschreibungPage({
      params: Promise.resolve({ id: DEMO.talwind }),
      searchParams: Promise.resolve(sp),
    }),
  );
}

function abschnitt() {
  return screen.getByRole('region', { name: /^(Abschnitt|Anhang|Gesamtansicht)/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seite.mockResolvedValue(SEITE);
  h.tenantLesen.mockResolvedValue(ZUST);
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) =>
      id ? (NAMEN[id.toLowerCase()] ?? UNBEKANNTE_PERSON) : KEINE_PERSON,
    bekannt: (id: string | null) => !!id && id.toLowerCase() in NAMEN,
  }));
});

describe('CMS-Beschreibung', () => {
  it('aktueller Entwurf: Zuständigkeit an den Dienst, Bearbeiten und Einreichen angeboten', async () => {
    daten();
    await rendern();
    expect(h.lesen).toHaveBeenCalledWith(
      SEITE,
      expect.objectContaining({ name: 'beschreibungLesen' }),
      { query: { berufstraegerId: DEMO.anna, bearbeitungId: DEMO.leon } },
    );
    expect(screen.getByText('Version 1.3 · Entwurf')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Zur Kanzlei-Review einreichen/ })).toHaveProperty(
      'disabled',
      false,
    );
    const karte = abschnitt();
    expect(within(karte).getByRole('heading').textContent).toBe(
      'Abschnitt 0 – Teilbereich und Abgrenzung',
    );
    expect(
      within(karte)
        .getByRole('link', { name: /Bearbeiten/ })
        .getAttribute('href'),
    ).toBe(`${BASIS}/beschreibung?bearbeiten=1`);
    // Versionen neueste zuerst; aktuelle markiert.
    const versionen = screen.getByRole('region', { name: 'Versionen' });
    const links = within(versionen).getAllByRole('link');
    expect(links.map((l) => l.textContent?.match(/v\d\.\d/)?.[0])).toEqual([
      'v1.3',
      'v1.2',
      'v1.1',
      'v1.0',
    ]);
    expect(links[0]!.getAttribute('aria-current')).toBe('true');
    // Kein eingefrorener Inhalt für den Entwurf.
    const snap = screen.getByRole('region', { name: 'Eingefrorener Inhalt' });
    expect(snap.textContent).toContain('Lebende Bausteine zeigen den Stand 19.10.2026');
  });

  it('lebende Bausteine: Namen aus der kanzleikonsole statt Text des Dienstes', async () => {
    daten();
    await rendern({ abschnitt: 'organisation' });
    const karte = abschnitt();
    expect(karte.textContent).toContain('Gesetzliche Vertretung: Jana Weller');
    expect(karte.textContent).toContain('Berufsträger:in (Kanzlei): StB Dr. Anna Roth');
    // ID ohne Namen in der kanzleikonsole: „Unbekannte Person“, nie der Platzhalter des Dienstes.
    expect(karte.textContent).toContain(UNBEKANNTE_PERSON);
    expect(karte.textContent).toContain('automatisch · Stand 19.10.2026');
    expect(h.namen.mock.calls[0]![1]).toEqual(
      expect.arrayContaining([DEMO.jana, DEMO.murat, DEMO.anna, DEMO.leon]),
    );
  });

  it('eingefrorene Version: Inhalt mit Hash, eingefrorene Namen, keine Bearbeitung', async () => {
    const { b } = daten();
    const v12 = b.versionen.find((v) => v.id === V12)!;
    v12.snapshot!.bausteine = {
      VERANTWORTUNG: {
        rollen: [{ rolle: 'Gesetzliche Vertretung', name: 'Jana Weller-Alt', personId: DEMO.jana }],
        kontrollen: [],
      },
    } as never;
    await rendern({ version: V12, abschnitt: 'organisation', bearbeiten: '1' });
    expect(screen.getByText('Version 1.2 · Zur Mandantenfreigabe')).toBeTruthy();
    const karte = abschnitt();
    // Eingefrorener Name (Snapshot), nicht der heutige Name der kanzleikonsole.
    expect(karte.textContent).toContain('Gesetzliche Vertretung: Jana Weller-Alt');
    expect(karte.textContent).toContain('eingefroren');
    expect(within(karte).queryByRole('link', { name: /Bearbeiten/ })).toBeNull();
    expect(karte.querySelector('textarea')).toBeNull();
    expect(karte.textContent).toContain('Nur Entwürfe sind bearbeitbar');
    const snap = screen.getByRole('region', { name: 'Eingefrorener Inhalt' });
    expect(snap.textContent).toContain(
      'SHA-256 85050466cd367af859c683d047f4797ec64f2a757f31e84e1a4089ad34d808d3',
    );
    expect(snap.textContent).toContain('Hash geprüft: Inhalt unverändert');
    // Hinweis auf die offene Anforderung mit Empfänger aus der kanzleikonsole.
    const hinweis = screen
      .getAllByRole('note')
      .find((n) => n.textContent?.includes('Zur Freigabe'))!;
    expect(hinweis.textContent).toContain('Zur Freigabe bei Jana Weller');
    expect(within(hinweis).getByRole('link').getAttribute('href')).toBe(`${BASIS}/kommunikation`);
    expect(screen.getByText(/wartet auf Freigabe durch den/)).toBeTruthy();
  });

  it('Snapshot ohne Bausteindaten: Hinweis statt lebender Daten', async () => {
    daten();
    await rendern({ version: V12, abschnitt: 'organisation' });
    const karte = abschnitt();
    expect(karte.textContent).toContain('Dieser Snapshot enthält nur die Gliederung');
    expect(karte.textContent).not.toContain('Jana Weller');
  });

  it('abweichender Hash: Warnung als Alarm', async () => {
    const { b } = daten();
    b.versionen.find((v) => v.id === V12)!.snapshotGeprueft = false;
    await rendern({ version: V12 });
    expect(screen.getByRole('alert').textContent).toContain('Hash weicht vom gespeicherten');
  });

  it('Bearbeiten öffnet den Editor nur für den Entwurf', async () => {
    daten();
    await rendern({ bearbeiten: '1' });
    const karte = abschnitt();
    expect(karte.querySelectorAll('textarea[name="text"]').length).toBeGreaterThan(0);
    expect((karte.querySelector('input[name="versionId"]') as HTMLInputElement).value).toBe(V13);
  });

  it.each([
    [DEMO.anna, true],
    [DEMO.leon, false],
  ])(
    'Kanzlei-Review: wer zuletzt bearbeitet hat (%s), bekommt den Abschluss nicht angeboten',
    async (letzte, gesperrt) => {
      const { b } = daten();
      Object.assign(b.versionen.at(-1)!, {
        status: 'KANZLEI_REVIEW',
        anzeige: 'KANZLEI_REVIEW',
        letzteBearbeitung: letzte,
      });
      await rendern();
      const knopf = screen.getByRole('button', { name: /Review abschließen/ });
      expect(knopf).toHaveProperty('disabled', gesperrt);
      expect(screen.getByRole('button', { name: /Zurück in den Entwurf/ })).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: /Freigabe beim Mandanten anfordern/ }),
      ).toBeNull();
    },
  );

  it('nach der Review: Freigabe anfordern nur an gesetzliche Vertretungen dieses Mandanten', async () => {
    const { b, kontext } = daten();
    Object.assign(b.versionen.at(-1)!, {
      status: 'KANZLEI_REVIEW',
      anzeige: 'KANZLEI_REVIEW',
      reviewVon: DEMO.leon,
      reviewAm: '2026-10-18T10:00:00.000Z',
    });
    // Rolle GV ohne Eintrag in `gesetzlicheVertreter` des Dienstes: nicht wählbar.
    kontext.kontaktRollen.push({
      kontaktId: DEMO.murat,
      rolle: 'GESETZLICHER_VERTRETER',
      funktion: null,
    });
    await rendern();
    fireEvent.click(screen.getByRole('button', { name: /Freigabe beim Mandanten anfordern/ }));
    const dialog = screen.getByRole('dialog');
    const auswahl = within(dialog).getByRole('combobox', {
      name: 'Empfänger (gesetzliche Vertretung)',
    });
    expect([...auswahl.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Jana Weller',
    ]);
    expect(dialog.textContent).toContain(
      'Die offene Anforderung für Version 1.2 wird zurückgezogen.',
    );
    expect((dialog.querySelector('input[name="versionId"]') as HTMLInputElement).value).toBe(V13);
  });

  it('ohne Schreibrecht: Aktionen gesperrt mit Grund, keine Bearbeitung', async () => {
    const { b } = daten();
    b.darfBearbeiten = false;
    await rendern();
    expect(screen.getByRole('button', { name: /Zur Kanzlei-Review einreichen/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: /Neue Version anlegen/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(abschnitt()).queryByRole('link', { name: /Bearbeiten/ })).toBeNull();
    expect(screen.getAllByText(TCMS_KEIN_RECHT.BEARBEITEN).length).toBeGreaterThan(0);
  });

  it('historischer Stand: Stichtag an den Dienst, Links behalten ihn, nur Lesen', async () => {
    const { b, kontext } = daten();
    Object.assign(kontext, { historisch: true, stand: '2026-09-30' });
    Object.assign(b, { historisch: true, stand: '2026-09-30' });
    await rendern({ stand: '2026-09-30' });
    expect(h.lesen.mock.calls[0]![2]).toEqual({
      query: { stand: '2026-09-30', berufstraegerId: DEMO.anna, bearbeitungId: DEMO.leon },
    });
    expect(screen.getByText('Stand zum Stichtag – nur Lesen')).toBeTruthy();
    const gliederung = screen.getByRole('navigation', { name: 'Gliederung der CMS-Beschreibung' });
    for (const a of within(gliederung).getAllByRole('link')) {
      expect(a.getAttribute('href')).toContain('stand=2026-09-30');
    }
    expect(within(abschnitt()).queryByRole('link', { name: /Bearbeiten/ })).toBeNull();
  });

  it('ohne Versionen: erste Version anlegen', async () => {
    const { b } = daten();
    b.versionen = [];
    b.freigaben = [];
    await rendern();
    expect(screen.getByRole('button', { name: /Erste Version anlegen/ })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('ohne Programm bzw. ohne Mandant im Tax-CMS: kein Abruf der Beschreibung', async () => {
    const { kontext } = daten();
    kontext.programm = null;
    await rendern();
    expect(
      screen.getByText('Für diesen Mandanten ist noch kein Tax-CMS eingerichtet.'),
    ).toBeTruthy();
    h.lesenOptional.mockResolvedValue({ ok: true, daten: null, requestId: null });
    await rendern();
    expect(h.lesen).not.toHaveBeenCalled();
    expect(h.tenantLesen).not.toHaveBeenCalled();
  });
});
