// @vitest-environment jsdom
// TCMS Stufe 3, Bereich D: Kontrollaufgabe, Ereignis melden und Freigaben im
// Portal als Render-Tests mit Antworten des Dienstes (Demo: Murat Aydin bzw.
// Jana Weller, Talwind Outdoor GmbH). Schutzregeln der Anzeige:
//   - Was die Person darf (`rechte.*`, `darfFreigeben`, `sperrgrund`,
//     Codezustand, `pruefung.maengel`), kommt aus der Antwort; die Seite
//     rechnet nichts nach und zeigt den Grund.
//   - Der Bestätigungscode erscheint nie; das Eingabefeld gibt es nur bei
//     aktivem Code und es wird direkt nach dem Absenden geleert.
//   - Anlagen nur über den Abruf der kanzleikonsole.
// Fachkatalog: TCMS-DIENST-001
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seite: vi.fn(),
  lesen: vi.fn(),
  namen: vi.fn(),
  ansprech: vi.fn(),
  upload: true,
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
  tcmsPortalSeite: h.seite,
  tcmsLesen: h.lesen,
  tcmsNamenLesen: h.namen,
  tcmsTenantLesen: (_seite: unknown, f: (tx: unknown) => unknown) => f({}),
}));
vi.mock('@/server/tcms/portal/ansprechpartner', () => ({ ansprechpersonenTx: h.ansprech }));
vi.mock('@/server/settings/portal-features', () => ({
  readPortalFeaturesTx: async () => ({ documentUpload: h.upload }),
}));
// Aktionen werden nur gebunden, nicht ausgeführt.
vi.mock('../aufgaben/[id]/actions', () => ({
  portalAnlageEntfernenAction: vi.fn(),
  portalAnlagenHochladenAction: vi.fn(),
  portalAufgabeBestaetigenAction: vi.fn(),
  portalAufgabeSpeichernAction: vi.fn(),
  portalAufgabeZurueckgebenAction: vi.fn(),
}));
vi.mock('../ereignis/actions', () => ({ portalEreignisMeldenAction: vi.fn() }));
vi.mock('../freigaben/actions', () => ({
  portalFreigabeCodeAnfordernAction: vi.fn(),
  portalFreigebenAction: vi.fn(),
  portalKenntnisnahmeAction: vi.fn(),
}));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { renderServer } from '@/__tests__/render-helpers';
import { FreigabeCodeFormular, CODE_FELD } from '@/components/tcms/portal/freigabe-formulare';
import { KEINE_PERSON, UNBEKANNTE_PERSON } from '@/server/tcms/namen';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import PortalKontrollaufgabePage from '../aufgaben/[id]/page';
import PortalEreignisPage from '../ereignis/page';
import PortalFreigabenPage from '../freigaben/page';

const AUFGABE = 'cmvf9ne7i007kdy7d467junj7';
const NAMEN: Record<string, string> = {
  [DEMO.jana]: 'Jana Weller',
  [DEMO.murat]: 'Murat Aydin',
  [DEMO.sabine]: 'Sabine Kraus',
  [DEMO.anna]: 'StB Dr. Anna Roth',
};

function seiteFuer(contactId: string) {
  return {
    ok: true,
    art: 'PORTAL',
    session: { user: { tenantId: DEMO.tenant, contactId, clientId: DEMO.talwind } },
    akteur: {},
    mandantId: DEMO.talwind,
    mandant: { id: DEMO.talwind, name: 'Talwind Outdoor GmbH', datevNo: null },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  h.upload = true;
  h.namen.mockImplementation(async () => ({
    name: (id: string | null) => (id ? (NAMEN[id] ?? UNBEKANNTE_PERSON) : KEINE_PERSON),
    bekannt: (id: string | null) => !!id && id in NAMEN,
  }));
  h.ansprech.mockResolvedValue({
    berufstraeger: { id: DEMO.anna, name: 'StB Dr. Anna Roth' },
    hauptbearbeitung: { id: DEMO.leon, name: 'Leon Brandt' },
  });
});

describe('Kontrollaufgabe im Portal', () => {
  let aufgabe = tcmsFixtures.portalAufgabeK23Murat();

  function seite(sp: Record<string, string> = {}, id = AUFGABE) {
    h.lesen.mockResolvedValue({ ok: true, daten: aufgabe, requestId: 'r' });
    return renderServer(
      PortalKontrollaufgabePage({
        params: Promise.resolve({ id }),
        searchParams: Promise.resolve(sp),
      }),
    );
  }

  beforeEach(() => {
    aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    h.seite.mockResolvedValue(seiteFuer(DEMO.murat));
  });

  it('Mängel laut Dienst, Anlagen über den Abruf, Upload mit Bearbeitungsrecht', async () => {
    await seite();
    expect(h.lesen).toHaveBeenCalledWith(
      seiteFuer(DEMO.murat),
      expect.objectContaining({ name: 'portalAufgabeLesen' }),
      { params: { durchfuehrungId: AUFGABE }, query: {} },
    );
    expect(screen.getByText(aufgabe.pruefung.maengel.join(' · '), { exact: false })).toBeTruthy();
    for (const n of aufgabe.nachweise) {
      const links = screen.getAllByRole('link', {
        name: new RegExp(n.dateiname.replace('.', '\\.')),
      });
      expect(links[0]!.getAttribute('href')).toBe(
        `/api/portal/tcms/aufgaben/${AUFGABE}/anlagen/${n.id}`,
      );
    }
    expect(screen.getByLabelText('Dateien auswählen')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Entfernen/ })).toHaveLength(2);
  });

  it('ohne Bearbeitungsrecht laut Dienst: kein Upload, kein Entfernen, Grund sichtbar', async () => {
    aufgabe.rechte.bearbeiten = { erlaubt: false, grund: 'Nur die zugewiesene Person.' };
    await seite();
    expect(screen.queryByLabelText('Dateien auswählen')).toBeNull();
    expect(screen.queryByRole('button', { name: /Entfernen/ })).toBeNull();
    expect(screen.getAllByText(/Nur die zugewiesene Person\./).length).toBeGreaterThan(0);
  });

  it('Portal-Uploads in der Kanzlei aus: Hinweis statt Upload', async () => {
    h.upload = false;
    await seite();
    expect(screen.queryByLabelText('Dateien auswählen')).toBeNull();
    expect(screen.getByText(/nicht freigeschaltet/)).toBeTruthy();
  });

  it('Hinweis nach Abruf nur für bekannte Codes', async () => {
    await seite({ anlage: 'abweichend' });
    expect(screen.getByRole('alert').textContent).toMatch(/nicht ausgeliefert/);
    document.body.innerHTML = '';
    await seite({ anlage: '__proto__' });
    expect(screen.queryByText(/nicht ausgeliefert/)).toBeNull();
  });

  it('ungültige ID oder zum Stichtag nicht vorhanden: 404', async () => {
    await expect(seite({}, '../x')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(h.lesen).not.toHaveBeenCalled();
    aufgabe.vorhandenZumStand = false;
    await expect(seite()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('Ereignis melden', () => {
  function lesen(u = tcmsFixtures.portalUebersichtJana()) {
    h.lesen.mockImplementation(async (_s, e: { name: string }) => ({
      ok: true,
      daten: e.name === 'portalMeldungenLesen' ? tcmsFixtures.portalMeldungenJana() : u,
      requestId: 'r',
    }));
  }

  beforeEach(() => {
    h.seite.mockResolvedValue(seiteFuer(DEMO.jana));
  });

  it('mit Melderecht: Formular und bisherige Meldungen', async () => {
    lesen();
    await renderServer(PortalEreignisPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('form', { name: 'Ereignis melden' })).toBeTruthy();
    expect(screen.getAllByText('2026-T-0345').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Anlagen (optional)')).toBeTruthy();
  });

  it('ohne Melderecht laut Dienst: Formular gesperrt mit festem Hinweis', async () => {
    const u = tcmsFixtures.portalUebersichtJana();
    u.rechte.melden = false;
    lesen(u);
    await renderServer(PortalEreignisPage({ searchParams: Promise.resolve({}) }));
    const senden = screen.getByRole('button', { name: /Ereignis melden/ }) as HTMLButtonElement;
    expect(senden.disabled).toBe(true);
    expect(
      screen.getAllByText(TCMS_KEIN_RECHT.PORTAL_ROLLE, { exact: false }).length,
    ).toBeGreaterThan(0);
  });

  it('Bestätigung nur für eine Vorgangsnummer aus der eigenen Liste', async () => {
    lesen();
    await renderServer(
      PortalEreignisPage({ searchParams: Promise.resolve({ gemeldet: '2026-T-0345' }) }),
    );
    expect(screen.getByText('Vorgangsnummer: 2026-T-0345')).toBeTruthy();
    expect(screen.getByText(/meldet sich Leon Brandt/)).toBeTruthy();
    document.body.innerHTML = '';
    await renderServer(
      PortalEreignisPage({ searchParams: Promise.resolve({ gemeldet: '<b>x</b>' }) }),
    );
    expect(screen.queryByText(/Vorgangsnummer/)).toBeNull();
  });
});

describe('Freigaben und Kenntnisnahmen', () => {
  let freigaben = tcmsFixtures.portalFreigabenJana();

  async function seite() {
    h.lesen.mockResolvedValue({ ok: true, daten: freigaben, requestId: 'r' });
    return renderServer(PortalFreigabenPage({ searchParams: Promise.resolve({}) }));
  }

  function beschreibung() {
    return freigaben.freigaben.find((f) => f.art === 'BESCHREIBUNG')!;
  }

  beforeEach(() => {
    freigaben = tcmsFixtures.portalFreigabenJana();
    h.seite.mockResolvedValue(seiteFuer(DEMO.jana));
  });

  it('Code noch nicht angefordert: nur Anfordern, kein Eingabefeld; fremde Kenntnisnahme mit Grund', async () => {
    await seite();
    expect(
      screen.getByRole('button', { name: /Bestätigungscode per E-Mail anfordern/ }),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Bestätigungscode (6 Ziffern)')).toBeNull();
    expect(
      screen.getByText('Diese Kenntnisnahme ist an eine andere Person gerichtet.'),
    ).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: /gelesen/ })).toBeNull();
  });

  it('aktiver Code: Eingabefeld (leer, ohne Vorbelegung) und Restversuche laut Dienst', async () => {
    beschreibung().code = {
      status: 'AKTIV',
      ablauf: '2026-10-19T18:00:00.000Z',
      verbleibendeVersuche: 4,
    };
    await seite();
    const feld = screen.getByLabelText('Bestätigungscode (6 Ziffern)') as HTMLInputElement;
    expect(feld.value).toBe('');
    expect(feld.getAttribute('autocomplete')).toBe('one-time-code');
    expect(screen.getByText(/noch 4 Versuche/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Code erneut senden/ })).toBeTruthy();
  });

  it('gesperrter Code: weder Eingabe noch Anfordern', async () => {
    beschreibung().code = { status: 'GESPERRT', ablauf: null, verbleibendeVersuche: 0 };
    await seite();
    expect(screen.queryByLabelText('Bestätigungscode (6 Ziffern)')).toBeNull();
    expect(screen.queryByRole('button', { name: /anfordern|erneut senden/ })).toBeNull();
    expect(screen.getByText(/nach mehreren Fehlversuchen gesperrt/)).toBeTruthy();
  });

  it('vorgelegte Fassung über die gemeinsame Darstellung der Beschreibung (eingefroren, mit SHA-256)', async () => {
    const f = beschreibung();
    await seite();
    const karte = screen.getByRole('article', { name: new RegExp(f.titel) });
    expect(within(karte).getByText('Vorgelegte Fassung, durch SHA-256 gebunden.')).toBeTruthy();
    // Bausteine des Snapshots wie in der Kanzlei: eingefroren, ohne erfundene Daten.
    expect(within(karte).getAllByText(/eingefroren/).length).toBeGreaterThan(0);
    expect(within(karte).getByText(/enthält nur die Gliederung/)).toBeTruthy();
    expect(karte.querySelector(`#freigabe-${f.id}-teilbereich`)).not.toBeNull();
  });

  it('ohne Freigaberecht laut Dienst: Grund statt Bedienung', async () => {
    const f = beschreibung();
    f.darfFreigeben = false;
    f.sperrgrund = 'Nur die adressierte Person kann freigeben.';
    await seite();
    expect(screen.getByText('Nur die adressierte Person kann freigeben.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /anfordern/ })).toBeNull();
  });
});

describe('FreigabeCodeFormular', () => {
  it('liest den Code einmal, leert das Feld sofort und zeigt ihn nie an', async () => {
    let gesendet: string | null = null;
    const aktion = vi.fn(async (_v: unknown, fd: FormData) => {
      gesendet = String(fd.get(CODE_FELD));
      return { ok: false as const, error: 'Der Code stimmt nicht. Noch 2 Versuche.' };
    });
    render(<FreigabeCodeFormular aktion={aktion} freigabeTitel="CMS-Beschreibung v1.2" />);
    const feld = screen.getByLabelText('Bestätigungscode (6 Ziffern)') as HTMLInputElement;
    fireEvent.change(feld, { target: { value: '481516' } });
    await act(async () => {
      fireEvent.submit(feld.form!);
    });
    expect(feld.value).toBe('');
    await waitFor(() => expect(aktion).toHaveBeenCalledTimes(1));
    expect(gesendet).toBe('481516');
    await waitFor(() => expect(screen.getByText(/Noch 2 Versuche/)).toBeTruthy());
    expect(document.body.innerHTML).not.toContain('481516');
  });
});
