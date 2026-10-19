// TCMS Stufe 3, Bereich D: Aktionen des Portals (Kontrollaufgabe, Meldung,
// Freigaben). Ablauf, Gate und Fehlerabbildung testet
// server/tcms/__tests__/aktion.test.ts; hier geht es darum, was die Aktion
// dem Helfer übergibt und wann sie den Dienst ruft. Schutzregeln:
//   - Mandant nur aus der Sitzung: keine Aktion nimmt eine Mandanten-ID an,
//     Formularfelder wie `mandantId` werden ignoriert.
//   - Dateien werden erst angenommen, nachdem das Tax-CMS das Recht meldet
//     (Aufgabe: `rechte.bearbeiten`, Meldung: `rechte.melden` und Programm).
//   - Übermitteln nur ohne Mängel laut Prüfung des Dienstes.
//   - Der Freigabe-Code geht nur in den Body des Dienstaufrufs; er erscheint
//     in keinem Ergebnis und keiner Weiterleitung.
//   - Anlagen einer Kontrollaufgabe sind Nachweise (TCMS-NACHWEIS-001): Das
//     Dokument wird beim Ablegen verknüpft, nach Annahme mit der Nachweis-ID
//     bestätigt, nach eindeutiger Ablehnung oder nach dem Entfernen
//     freigegeben; bei offenem Ausgang bleibt die Sperre.
//   - Anlagen einer Ereignismeldung (TCMS s7) ebenso: gebunden beim Ablegen,
//     Ereignis-ID nach Annahme, Freigabe nach eindeutiger Ablehnung.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-NACHWEIS-001
import { TcmsKonflikt, TcmsNichtVerfuegbar } from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  ergebnis: { ok: true } as Record<string, unknown>,
  ablegen: vi.fn(),
  nachweisAblegen: vi.fn(),
  bestaetigen: vi.fn(),
  freigeben: vi.fn(),
  zuordnen: vi.fn(),
  meldungFreigeben: vi.fn(),
  kontext: vi.fn(),
  ansprech: vi.fn(),
  redirect: vi.fn((ziel: string) => {
    throw new Error(`REDIRECT ${ziel}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsPortalAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return h.ergebnis;
  }),
}));
// Ablage-Modul mit echtem Dateifeld, aber ohne Dokumentenpipeline.
vi.mock('@/server/actions/audit', () => ({}));
vi.mock('@/server/documents/journaled-upload', () => ({}));
vi.mock('@/server/documents/upload-helpers', () => ({}));
vi.mock('@/server/rate-limit', () => ({}));
vi.mock('@/server/settings/portal-features', () => ({}));
vi.mock('@/server/tcms/portal/anlagen', async (original) => ({
  ...(await original<typeof import('@/server/tcms/portal/anlagen')>()),
  portalAnlageAblegen: h.ablegen,
  portalNachweisAblegen: h.nachweisAblegen,
  portalAblageKontext: h.kontext,
}));
// Verknüpfungen (TCMS-NACHWEIS-001) ohne Datenbank; Ablauf aus nachweis-aktion.ts echt.
vi.mock('@/server/tcms/durchfuehrung/verweis', () => ({
  nachweisVerknuepfenTx: vi.fn(),
  nachweisVerknuepfungBestaetigen: h.bestaetigen,
  nachweisVerknuepfungFreigeben: h.freigeben,
  meldungsAnlagenZuordnen: h.zuordnen,
  meldungsAnlagenFreigeben: h.meldungFreigeben,
}));
vi.mock('@/server/tcms/portal/ansprechpartner', () => ({ ansprechpersonenTx: h.ansprech }));

import { DEMO, tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { TCMS_KEIN_RECHT } from '@/server/tcms/zustand';
import {
  portalAnlageEntfernenAction,
  portalAnlagenHochladenAction,
  portalAufgabeBestaetigenAction,
  portalAufgabeSpeichernAction,
  portalAufgabeZurueckgebenAction,
} from '../aufgaben/[id]/actions';
import { portalEreignisMeldenAction } from '../ereignis/actions';
import {
  portalFreigabeCodeAnfordernAction,
  portalFreigebenAction,
  portalKenntnisnahmeAction,
} from '../freigaben/actions';

const AUFGABE = 'cmvf9ne7i007kdy7d467junj7';
const NACHWEIS = 'cmvf9ne96007qdy7d0c2yfigq';
const FREIGABE = 'cmvf9nef30095dy7dsx5tay68';
const CODE = '481516';
const TX = { tx: true };
const G = { tenantId: DEMO.tenant, contactId: DEMO.murat, clientId: DEMO.talwind };
const CTX = { tenantId: DEMO.tenant, actorId: DEMO.murat, actorType: 'CLIENT_CONTACT' };
const K = { g: { ...G, ctx: CTX }, akteur: {}, mandantId: DEMO.talwind };
const ABLAGE = { ...G, ctx: CTX };
const VERKNUEPFUNG = 'e1000000-0000-4000-8000-0000000000c1';
const MELDUNG_VERKNUEPFUNG = 'e2000000-0000-4000-8000-0000000000c2';
const EREIGNIS = 'cmvf9ereignis0400abcdef';

interface Spec {
  keinRecht?: string;
  mandantId?: unknown;
  parse?: () => { ok: boolean; data?: unknown; error?: string; fieldErrors?: unknown };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

/** Dienst-Attrappe: Antwort je Endpunktname; protokolliert die Reihenfolge. */
function dienst(antworten: Record<string, unknown>, ablauf: string[] = []) {
  const rufe = vi.fn(async (e: { name: string }) => {
    ablauf.push(e.name);
    return { daten: antworten[e.name] ?? {}, requestId: 'r' };
  });
  return { rufe };
}

function formular(felder: Array<[string, string | File]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

function datei(name: string, inhalt = 'a;b\n1;2\n'): File {
  return new File([inhalt], name, { type: 'text/csv' });
}

/** Helfer meldet Fehlschlag: Aktionen mit Weiterleitung nach Erfolg bleiben im Test. */
function ohneWeiterleitung() {
  h.ergebnis = { ok: false, error: 'Test' };
}

/** parse → vorbereiten → aufruf wie der Helfer (ohne Gate). */
async function lauf(antworten: Record<string, unknown>, ablauf: string[] = []) {
  const s = spec();
  const p = s.parse ? s.parse() : { ok: true, data: undefined };
  expect(p.ok, JSON.stringify(p)).toBe(true);
  const v = s.vorbereiten ? await s.vorbereiten(TX, K, p.data) : undefined;
  const d = dienst(antworten, ablauf);
  const r = await s.aufruf(d, p.data, v);
  return { d, r };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.ergebnis = { ok: true };
  h.kontext.mockResolvedValue(ABLAGE);
  h.ablegen.mockImplementation(async (_g, f: File) => ({
    verknuepfungId: MELDUNG_VERKNUEPFUNG,
    verweis: {
      dokumentId: 'd0c00000-0000-4000-8000-0000000000c1',
      dateiname: f.name,
      mime: 'text/csv',
      groesse: f.size,
      sha256: 'cd'.repeat(32),
    },
  }));
  h.zuordnen.mockResolvedValue(1);
  h.meldungFreigeben.mockResolvedValue(1);
  h.nachweisAblegen.mockImplementation(async (_g, f: File) => ({
    verknuepfungId: VERKNUEPFUNG,
    verweis: {
      dokumentId: 'd0c00000-0000-4000-8000-0000000000c1',
      dateiname: f.name,
      mime: 'text/csv',
      groesse: f.size,
      sha256: 'cd'.repeat(32),
    },
  }));
  h.bestaetigen.mockResolvedValue(true);
  h.freigeben.mockResolvedValue(1);
  h.ansprech.mockResolvedValue({
    berufstraeger: { id: DEMO.anna, name: 'StB Dr. Anna Roth' },
    hauptbearbeitung: { id: DEMO.leon, name: 'Leon Brandt' },
  });
});

describe('Mandant nur aus der Sitzung', () => {
  it('keine Portal-Aktion übergibt einen Mandanten; Formularfelder ändern das nicht', async () => {
    const fd = formular([
      ['mandantId', DEMO.seestern],
      ['clientId', DEMO.seestern],
      ['absicht', 'speichern'],
    ]);
    const aufrufe = [
      () => portalAufgabeSpeichernAction(AUFGABE, null, fd),
      () => portalAnlagenHochladenAction(AUFGABE, null, fd),
      () => portalAnlageEntfernenAction(AUFGABE, NACHWEIS, null, fd),
      () => portalAufgabeZurueckgebenAction(AUFGABE, null, fd),
      () => portalAufgabeBestaetigenAction(AUFGABE, null, fd),
      () => portalFreigabeCodeAnfordernAction(FREIGABE, null, fd),
    ];
    for (const aufruf of aufrufe) {
      h.spec = null;
      await aufruf();
      expect(spec()).not.toHaveProperty('mandantId');
    }
    // Pfad-Parameter der Dienstaufrufe ohne Mandant (den setzt der Helfer aus der Sitzung).
    await portalAnlageEntfernenAction(AUFGABE, NACHWEIS, null, fd);
    const { d } = await lauf({});
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalAnlageEntfernen, {
      params: { durchfuehrungId: AUFGABE, nachweisId: NACHWEIS },
    });
    // Freigabe der Verknüpfung mit dem Mandanten der Sitzung, nie aus dem Formular.
    expect(h.freigeben).toHaveBeenCalledWith(
      CTX,
      { mandantId: DEMO.talwind, durchfuehrungId: AUFGABE, nachweisId: NACHWEIS },
      'REMOVED',
    );
  });

  it('Entfernen: Verknüpfung erst nach Erfolg im Tax-CMS frei (TCMS-NACHWEIS-001)', async () => {
    await portalAnlageEntfernenAction(AUFGABE, NACHWEIS, null, new FormData());
    const s = spec();
    const p = s.parse!();
    const v = await s.vorbereiten!(TX, K, p.data);
    const fehler = new TcmsKonflikt({ status: 409 });
    const rufe = vi.fn(async () => {
      throw fehler;
    });
    await expect(s.aufruf({ rufe }, p.data, v)).rejects.toBe(fehler);
    expect(h.freigeben).not.toHaveBeenCalled();
  });

  it('ungültige IDs: Ablehnung im Parse, kein Dienstaufruf', async () => {
    await portalAufgabeBestaetigenAction('../fremd', null, new FormData());
    expect(spec().parse!().ok).toBe(false);
    await portalFreigebenAction('x y', null, formular([['code', CODE]]));
    expect(spec().parse!().ok).toBe(false);
  });
});

describe('portalAufgabeSpeichernAction', () => {
  it('Body aus dem Formular nach dem Aufbau laut Dienst; Entwurf speichern', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    await portalAufgabeSpeichernAction(
      AUFGABE,
      null,
      formular([
        ['absicht', 'speichern'],
        ['schritt_0_erledigt', 'on'],
        ['schritt_0_kommentar', ' exportiert '],
        ['schritt_1_kommentar', ''],
        ['schritt_7_erledigt', 'on'],
        ['ergebnis', 'OHNE_BEFUND'],
        ['ergebnisKommentar', '  '],
      ]),
    );
    expect(spec().keinRecht).toBe('PORTAL_ZUGEORDNET');
    const ablauf: string[] = [];
    const { d, r } = await lauf(
      { portalAufgabeLesen: aufgabe, portalAufgabeSpeichern: aufgabe },
      ablauf,
    );
    expect(ablauf).toEqual(['portalAufgabeLesen', 'portalAufgabeSpeichern']);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalAufgabeSpeichern, {
      params: { durchfuehrungId: AUFGABE },
      body: {
        schritte: [
          { erledigt: true, kommentar: 'exportiert' },
          { erledigt: false, kommentar: '' },
        ],
        werte: [],
        ergebnis: 'OHNE_BEFUND',
        ergebnisKommentar: null,
      },
    });
    expect(r).toEqual({ meldung: 'Entwurf gespeichert.' });
  });

  it('Übermitteln mit Mängeln laut Dienst: gespeichert, nicht eingereicht, Mängel als Hinweis', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    await portalAufgabeSpeichernAction(AUFGABE, null, formular([['absicht', 'einreichen']]));
    const ablauf: string[] = [];
    const { r } = await lauf(
      { portalAufgabeLesen: aufgabe, portalAufgabeSpeichern: aufgabe },
      ablauf,
    );
    expect(ablauf).not.toContain('portalAufgabeEinreichen');
    expect(r).toEqual({
      warnung: `Entwurf gespeichert, aber noch nicht übermittelt: ${aufgabe.pruefung.maengel.join(' · ')}.`,
    });
  });

  it('Übermitteln ohne Mängel: einreichen nach dem Speichern', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    const gespeichert = { ...aufgabe, pruefung: { ...aufgabe.pruefung, maengel: [] } };
    await portalAufgabeSpeichernAction(AUFGABE, null, formular([['absicht', 'einreichen']]));
    const ablauf: string[] = [];
    const { r } = await lauf(
      { portalAufgabeLesen: aufgabe, portalAufgabeSpeichern: gespeichert },
      ablauf,
    );
    expect(ablauf).toEqual([
      'portalAufgabeLesen',
      'portalAufgabeSpeichern',
      'portalAufgabeEinreichen',
    ]);
    expect(r).toEqual({
      meldung: 'Übermittelt. Eine zweite Person bei Ihnen bestätigt nun die Vollständigkeit.',
    });
  });

  it('Betrag im falschen Format: Feldfehler, kein Speichern', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    aufgabe.kontrolle.kennzahlen = [
      { key: 'umsatz', label: 'Umsatz', differenzAus: null } as never,
    ];
    await portalAufgabeSpeichernAction(
      AUFGABE,
      null,
      formular([
        ['absicht', 'speichern'],
        ['wert_umsatz', '12,3,4'],
      ]),
    );
    const ablauf: string[] = [];
    const { r } = await lauf({ portalAufgabeLesen: aufgabe }, ablauf);
    expect(ablauf).toEqual(['portalAufgabeLesen']);
    expect(r).toMatchObject({ ok: false, fieldErrors: { wert_umsatz: [expect.any(String)] } });
  });
});

describe('portalAnlagenHochladenAction', () => {
  it('ohne Bearbeitungsrecht laut Dienst wird keine Datei abgelegt', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    aufgabe.rechte.bearbeiten = {
      erlaubt: false,
      grund: 'Nur die durchführende Person.',
      verweigerung: 'PORTAL_ZUGEORDNET',
    };
    await portalAnlagenHochladenAction(AUFGABE, null, formular([['dateien', datei('a.csv')]]));
    const ablauf: string[] = [];
    const { r } = await lauf({ portalAufgabeLesen: aufgabe }, ablauf);
    // TCMS s6: Grund des Dienstes → fester Text der kanzleikonsole, nie dessen Text.
    expect(r).toEqual({
      ok: false,
      error: TCMS_KEIN_RECHT.PORTAL_ZUGEORDNET,
      errorCode: 'FORBIDDEN',
    });
    expect(h.nachweisAblegen).not.toHaveBeenCalled();
    expect(h.ablegen).not.toHaveBeenCalled();
    expect(ablauf).toEqual(['portalAufgabeLesen']);
  });

  it('nur der Zustand steht entgegen (keine Verweigerung): fester Hinweis, nichts abgelegt', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    aufgabe.rechte.bearbeiten = {
      erlaubt: false,
      grund: 'Einreichung liegt vor — keine Änderung mehr möglich',
      verweigerung: null,
    };
    await portalAnlagenHochladenAction(AUFGABE, null, formular([['dateien', datei('a.csv')]]));
    const { r } = await lauf({ portalAufgabeLesen: aufgabe });
    expect(r).toEqual({
      ok: false,
      error: 'Für diese Aufgabe können Sie derzeit keine Anlagen hochladen.',
      errorCode: 'CONFLICT',
    });
    expect(h.nachweisAblegen).not.toHaveBeenCalled();
  });

  it('mit Recht: ablegen, Verweis aus der Ablage anhängen; gleicher Inhalt wird übersprungen', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    const neu = datei('neu.csv', 'x;y\n');
    const schonDa = datei('alt.csv', 'gleich');
    // SHA-256 von „gleich“ als vorhandener Nachweis.
    const { createHash } = await import('node:crypto');
    aufgabe.nachweise[0]!.sha256 = createHash('sha256').update('gleich').digest('hex');
    await portalAnlagenHochladenAction(
      AUFGABE,
      null,
      formular([
        ['dateien', neu],
        ['dateien', schonDa],
      ]),
    );
    const { d, r } = await lauf({
      portalAufgabeLesen: aufgabe,
      portalAnlageAnhaengen: { nachweis: { id: NACHWEIS } },
    });
    expect(h.kontext).toHaveBeenCalledWith(K.g);
    expect(h.ablegen).not.toHaveBeenCalled();
    expect(h.nachweisAblegen).toHaveBeenCalledTimes(1);
    // Ablegen und Verknüpfen mit genau dieser Durchführung (eine Commit-Transaktion).
    expect(h.nachweisAblegen).toHaveBeenCalledWith(ABLAGE, neu, AUFGABE);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalAnlageAnhaengen, {
      params: { durchfuehrungId: AUFGABE },
      body: {
        verweis: {
          dokumentId: 'd0c00000-0000-4000-8000-0000000000c1',
          dateiname: 'neu.csv',
          mime: 'text/csv',
          groesse: neu.size,
          sha256: 'cd'.repeat(32),
        },
      },
    });
    expect(r).toEqual({ meldung: '1 Datei hochgeladen; bereits vorhanden: alt.csv.' });
    // Annahme: Nachweis-ID an der Verknüpfung, keine Freigabe.
    expect(h.bestaetigen).toHaveBeenCalledWith(CTX, VERKNUEPFUNG, NACHWEIS);
    expect(h.freigeben).not.toHaveBeenCalled();
  });

  it('eindeutige Ablehnung: Verknüpfung frei („nicht angehängt“); offener Ausgang: Sperre bleibt', async () => {
    const aufgabe = tcmsFixtures.portalAufgabeK23Murat();
    const formularMitDatei = () => formular([['dateien', datei('neu.csv', 'x;y\n')]]);
    const mitFehler = async (fehler: Error) => {
      await portalAnlagenHochladenAction(AUFGABE, null, formularMitDatei());
      const s = spec();
      const p = s.parse!();
      const v = await s.vorbereiten!(TX, K, p.data);
      const rufe = vi.fn(async (e: { name: string }) => {
        if (e.name === 'portalAnlageAnhaengen') throw fehler;
        return { daten: aufgabe, requestId: 'r' };
      });
      await expect(s.aufruf({ rufe }, p.data, v)).rejects.toBe(fehler);
    };
    await mitFehler(new TcmsKonflikt({ status: 409 }));
    expect(h.freigeben).toHaveBeenCalledWith(CTX, { verknuepfungId: VERKNUEPFUNG }, 'NOT_ATTACHED');
    expect(h.bestaetigen).not.toHaveBeenCalled();
    h.freigeben.mockClear();
    await mitFehler(new TcmsNichtVerfuegbar('ZEITLIMIT'));
    expect(h.freigeben).not.toHaveBeenCalled();
    expect(h.bestaetigen).not.toHaveBeenCalled();
  });

  it('zu viele Dateien: Ablehnung im Parse', async () => {
    await portalAnlagenHochladenAction(
      AUFGABE,
      null,
      formular(
        Array.from({ length: 6 }, (_, i) => ['dateien', datei(`${i}.csv`)] as [string, File]),
      ),
    );
    expect(spec().parse!().ok).toBe(false);
  });
});

describe('Bestätigen und Zurückgeben (zweite Person beim Mandanten)', () => {
  it('Vier-Augen prüft der Dienst; die Aktion sendet nur ID und Begründung', async () => {
    const begruendung = 'Die Bankbelege für September fehlen noch vollständig in der Ablage.';
    await portalAufgabeZurueckgebenAction(AUFGABE, null, formular([['begruendung', begruendung]]));
    expect(spec().keinRecht).toBe('STANDARD');
    let { d } = await lauf({});
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalAufgabeZurueckgeben, {
      params: { durchfuehrungId: AUFGABE },
      body: { begruendung },
    });
    await portalAufgabeBestaetigenAction(AUFGABE, null, new FormData());
    ({ d } = await lauf({}));
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalAufgabeBestaetigen, {
      params: { durchfuehrungId: AUFGABE },
    });
  });
});

describe('portalEreignisMeldenAction', () => {
  const felder: Array<[string, string | File]> = [
    ['typ', 'T-01'],
    ['titel', 'Start auf Kaufland.de'],
    ['beschreibung', 'Ab Dezember verkaufen wir zusätzlich über Kaufland.de.'],
    ['datum', '2026-12-01'],
    ['zusage', '1'],
    ['anlagen', datei('plan.csv')],
    ['mandantId', DEMO.seestern],
    ['benachrichtigen', DEMO.thomas],
  ];

  it('ohne Melderecht laut Dienst (`melden` der Meldungen, TCMS s7): keine Ablage, keine Meldung', async () => {
    const m = tcmsFixtures.portalMeldungenJana();
    m.melden = false;
    ohneWeiterleitung();
    await portalEreignisMeldenAction(null, formular(felder));
    expect(spec().keinRecht).toBe('PORTAL_ROLLE');
    const ablauf: string[] = [];
    const { r } = await lauf({ portalMeldungenLesen: m }, ablauf);
    expect(r).toEqual({ ok: false, error: TCMS_KEIN_RECHT.PORTAL_ROLLE, errorCode: 'FORBIDDEN' });
    expect(h.ablegen).not.toHaveBeenCalled();
    // Ein Lesezugriff vor dem Upload, keine Portal-Übersicht.
    expect(ablauf).toEqual(['portalMeldungenLesen']);
  });

  it('ohne Programm: keine Ablage', async () => {
    const m = tcmsFixtures.portalMeldungenJana();
    m.programmVorhanden = false;
    ohneWeiterleitung();
    await portalEreignisMeldenAction(null, formular(felder));
    const ablauf: string[] = [];
    const { r } = await lauf({ portalMeldungenLesen: m }, ablauf);
    expect(r).toMatchObject({ ok: false, errorCode: 'FORBIDDEN' });
    expect(h.ablegen).not.toHaveBeenCalled();
    expect(ablauf).toEqual(['portalMeldungenLesen']);
  });

  it('mit Recht: Anlagen ablegen, Meldung mit Verweisen; benachrichtigt wird die Hauptbearbeitung aus der kanzleikonsole', async () => {
    ohneWeiterleitung();
    await portalEreignisMeldenAction(null, formular(felder));
    const ablauf: string[] = [];
    const { d, r } = await lauf(
      {
        portalMeldungenLesen: tcmsFixtures.portalMeldungenJana(),
        portalMeldungErfassen: { id: EREIGNIS, nummer: '2026-T-0400' },
      },
      ablauf,
    );
    expect(ablauf).toEqual(['portalMeldungenLesen', 'portalMeldungErfassen']);
    expect(h.ansprech).toHaveBeenCalledWith(TX, { tenantId: DEMO.tenant, mandantId: DEMO.talwind });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalMeldungErfassen, {
      body: {
        typ: 'T-01',
        titel: 'Start auf Kaufland.de',
        beschreibung: 'Ab Dezember verkaufen wir zusätzlich über Kaufland.de.',
        datum: '2026-12-01',
        anlagen: [expect.objectContaining({ dateiname: 'plan.csv', sha256: 'cd'.repeat(32) })],
        zusageAenderungen: true,
        benachrichtigen: { id: DEMO.leon, name: 'Leon Brandt' },
      },
    });
    expect(r).toEqual({ nummer: '2026-T-0400' });
    // TCMS-NACHWEIS-001: abgelegt im Kontext des Kontakts, gebunden; nach der
    // Annahme trägt die Verknüpfung die Ereignis-ID des Dienstes.
    expect(h.ablegen).toHaveBeenCalledWith(ABLAGE, expect.any(File));
    expect(h.zuordnen).toHaveBeenCalledWith(CTX, [MELDUNG_VERKNUEPFUNG], EREIGNIS);
    expect(h.meldungFreigeben).not.toHaveBeenCalled();
  });

  it('Anlagen (TCMS-NACHWEIS-001): eindeutige Ablehnung der Meldung → frei; offener Ausgang → Sperre bleibt', async () => {
    const mitFehler = async (fehler: Error) => {
      ohneWeiterleitung();
      await portalEreignisMeldenAction(null, formular(felder));
      const s = spec();
      const p = s.parse!();
      const v = await s.vorbereiten!(TX, K, p.data);
      const rufe = vi.fn(async (e: { name: string }) => {
        if (e.name === 'portalMeldungErfassen') throw fehler;
        return { daten: tcmsFixtures.portalMeldungenJana(), requestId: 'r' };
      });
      await expect(s.aufruf({ rufe }, p.data, v)).rejects.toBe(fehler);
    };
    await mitFehler(new TcmsKonflikt({ status: 409 }));
    expect(h.meldungFreigeben).toHaveBeenCalledWith(
      CTX,
      { verknuepfungIds: [MELDUNG_VERKNUEPFUNG] },
      'NOT_ATTACHED',
    );
    h.meldungFreigeben.mockClear();
    await mitFehler(new TcmsNichtVerfuegbar('ZEITLIMIT'));
    expect(h.meldungFreigeben).not.toHaveBeenCalled();
    expect(h.zuordnen).not.toHaveBeenCalled();
  });

  it('Titel einzeilig (TCMS s8): CR/LF und unsichtbare Zeichen als Feldfehler des Vertrags, kein Dienstaufruf', async () => {
    for (const titel of [
      'Start auf\nKaufland.de',
      `Start ${String.fromCodePoint(0x1f6d2, 0xfe0f)} Kaufland`,
    ]) {
      h.spec = null;
      ohneWeiterleitung();
      await portalEreignisMeldenAction(
        null,
        formular(felder.map(([k, v]) => [k, k === 'titel' ? titel : v] as [string, string | File])),
      );
      const p = spec().parse!();
      expect(p.ok, titel).toBe(false);
      expect((p.fieldErrors as Record<string, string[]>)['titel'], titel).toEqual([
        'Unzulässige Zeichen',
      ]);
    }
  });

  it('nach Erfolg zur Bestätigung mit der Vorgangsnummer des Dienstes', async () => {
    h.ergebnis = { ok: true, nummer: '2026-T-0400' };
    await expect(portalEreignisMeldenAction(null, formular(felder))).rejects.toThrow(
      'REDIRECT /portal/tcms/ereignis?gemeldet=2026-T-0400',
    );
  });
});

describe('Freigabe mit Bestätigungscode', () => {
  it('Code nur im Body des Dienstaufrufs; Ergebnis ohne Code', async () => {
    await portalFreigebenAction(FREIGABE, null, formular([['code', ` ${CODE} `]]));
    expect(spec().keinRecht).toBe('PORTAL_ZUGEORDNET');
    const { d, r } = await lauf({
      portalFreigabeErteilen: { freigegeben: false, grund: 'CODE_FALSCH', verbleibendeVersuche: 3 },
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalFreigabeErteilen, {
      params: { freigabeId: FREIGABE },
      body: { code: CODE },
    });
    expect(JSON.stringify(r)).not.toContain(CODE);
  });

  it('falscher Code: fester Text mit Restversuchen, ohne Code', async () => {
    h.ergebnis = { ok: true, freigegeben: false, grund: 'CODE_FALSCH', verbleibend: 2 };
    const r = await portalFreigebenAction(FREIGABE, null, formular([['code', CODE]]));
    expect(r).toEqual({
      ok: false,
      error: 'Der Code stimmt nicht. Noch 2 Versuche.',
      errorCode: 'VALIDATION_ERROR',
    });
    expect(JSON.stringify(r)).not.toContain(CODE);
  });

  it('gesperrt: fester Text ohne Code', async () => {
    h.ergebnis = { ok: true, freigegeben: false, grund: 'GESPERRT', verbleibend: 0 };
    const r = await portalFreigebenAction(FREIGABE, null, formular([['code', CODE]]));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CODE);
  });

  it('ungültiger Code: Feldfehler ohne die Eingabe', async () => {
    await portalFreigebenAction(FREIGABE, null, formular([['code', '12345x']]));
    const p = spec().parse!();
    expect(p.ok).toBe(false);
    expect(JSON.stringify(p)).not.toContain('12345x');
  });

  it('Erfolg: Weiterleitung zur Liste ohne Code', async () => {
    h.ergebnis = { ok: true, freigegeben: true };
    await expect(portalFreigebenAction(FREIGABE, null, formular([['code', CODE]]))).rejects.toThrow(
      `REDIRECT /portal/tcms/freigaben?erledigt=${FREIGABE}`,
    );
    expect(String(h.redirect.mock.calls[0]![0])).not.toContain(CODE);
  });

  it('Code anfordern: nur die Freigabe-ID, Ablauf aus der Antwort', async () => {
    await portalFreigabeCodeAnfordernAction(FREIGABE, null, new FormData());
    const { d, r } = await lauf({
      portalFreigabeCodeAnfordern: { codeAblauf: '2026-10-19T18:00:00.000Z' },
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalFreigabeCodeAnfordern, {
      params: { freigabeId: FREIGABE },
    });
    expect(r).toEqual({ meldung: expect.stringContaining('gültig bis') });
  });

  it('Kenntnisnahme nur mit Bestätigung des Lesens', async () => {
    ohneWeiterleitung();
    await portalKenntnisnahmeAction(FREIGABE, null, new FormData());
    expect(spec().parse!().ok).toBe(false);
    await portalKenntnisnahmeAction(FREIGABE, null, formular([['gelesen', 'on']]));
    const { d } = await lauf({});
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.portalKenntnisnahmeBestaetigen, {
      params: { freigabeId: FREIGABE },
      body: { gelesen: true },
    });
  });
});
