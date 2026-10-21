// TCMS Stufe 3, Bereich D: Aktionen des Ereigniseingangs (Triage). Ablauf, Gate
// und Fehlerabbildung testet server/tcms/__tests__/aktion.test.ts; hier geht es
// darum, was die Aktion dem Helfer übergibt. Schutzregeln:
//   - Mandant aus dem gebundenen Argument, nie aus dem Formular.
//   - Personen der Zuständigkeit werden VOR dem Dienstaufruf gegen den Mandanten
//     geprüft (Kanzlei: Zugriff, Mandant: Kontakt genau dieses Mandanten).
//   - Vier-Augen beim Verwerfen entscheidet der Dienst; die Bestätigung bildet
//     dessen Ablehnung auf den festen Vier-Augen-Text ab.
//   - Nach dem bestätigten Verwerfen werden die Anlagen einer Portal-Meldung
//     freigegeben – mit der Antwort des Dienstes und dem gebundenen Mandanten
//     (TCMS-NACHWEIS-001; Eindeutigkeit prüft portal-meldung.test.ts).
//   - Ungeklärte Anlagen einer Portal-Meldung (kk-tcms-s10nach) ordnen nur
//     Admins/Partner zu, und nur einem Ereignis, für das das Tax-CMS dieselbe
//     Anlage (SHA-256 und Dokument-ID) bestätigt; eine Freigabe gibt es hier nicht.
// Fachkatalog: TCMS-AKTEUR-001, TCMS-NACHWEIS-001
import { TcmsNichtGefunden, TcmsNichtVerfuegbar } from '@taxtronik/tcms-client';
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  kanzlei: vi.fn(),
  kontakte: vi.fn(),
  nachVerwerfen: vi.fn(),
  ungeklaert: vi.fn(),
  zuordnen: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/auth/rbac', () => ({}));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return { ok: true };
  }),
}));
vi.mock('@/server/tcms/portal/meldung', () => ({ meldungsAnlagenNachVerwerfen: h.nachVerwerfen }));
vi.mock('@/server/tcms/portal/meldevorgang', () => ({
  ungeklaerteAnlageTx: h.ungeklaert,
  ungeklaerteAnlageZuordnen: h.zuordnen,
}));
vi.mock('@/server/tcms/personen', async (original) => ({
  ...(await original<typeof import('@/server/tcms/personen')>()),
  kanzleiPersonenFuerMandantTx: h.kanzlei,
  mandantKontakteTx: h.kontakte,
}));

import { DEMO } from '@/__tests__/tcms-fixtures';
import { TcmsPersonUnzulaessig } from '@/server/tcms/personen';
import {
  ereignisAbschliessenAction,
  ereignisErfassenAction,
  ereignisInPruefungNehmenAction,
  ereignisVerwerfenAblehnenAction,
  ereignisVerwerfenBeantragenAction,
  ereignisVerwerfenBestaetigenAction,
  folgeErledigenAction,
  folgeHinzufuegenAction,
  folgenAnlegenAction,
  folgeVerwerfenAction,
  ungeklaerteAnlageZuordnenAction,
} from '../ereignisse/actions';

const MANDANT = DEMO.talwind;
const EREIGNIS = 'cmvf9ned0008hdy7dlufu2vuo';
const F_PROFIL = 'cmvf9ned1008idy7ddnhhtfja';
const F_RISIKO = 'cmvf9ned1008jdy7d547w1cbs';
const F_KONTROLLE = 'cmvf9ned1008kdy7dhy6gg6vm';
const TX = { tx: true };
const CTX = { tenantId: DEMO.tenant, actorId: DEMO.leon, actorType: 'STAFF' };
const K = { g: { tenantId: DEMO.tenant, ctx: CTX }, akteur: {}, mandantId: MANDANT };
const BEGRUENDUNG = 'Die Meldung betrifft eine bereits erfasste Änderung (2026-T-0342).';

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  parse?: () => { ok: boolean; data?: unknown; fieldErrors?: Record<string, unknown> };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

function dienst(antwort: unknown = {}) {
  return { rufe: vi.fn(async () => ({ daten: antwort, requestId: 'r' })) };
}

function formular(felder: Array<[string, string]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

async function lauf(antwort: unknown = {}) {
  const s = spec();
  const p = s.parse ? s.parse() : { ok: true, data: undefined };
  expect(p.ok, JSON.stringify(p)).toBe(true);
  const v = s.vorbereiten ? await s.vorbereiten(TX, K, p.data) : undefined;
  const d = dienst(antwort);
  return { d, r: await s.aufruf(d, p.data, v) };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.kanzlei.mockImplementation(async (_tx, _b, ids: string[]) => ids.map((id) => ({ id })));
  h.kontakte.mockImplementation(async (_tx, _b, ids: string[]) => ids.map((id) => ({ id })));
});

describe('ereignisErfassenAction', () => {
  it('Mandant aus dem gebundenen Argument; Body nach Vertrag', async () => {
    await ereignisErfassenAction(
      MANDANT,
      null,
      formular([
        ['typ', 'T-05'],
        ['quelle', 'MANUELL'],
        ['titel', 'USt-Sonderprüfung angekündigt'],
        ['beschreibung', 'Prüfungsanordnung für Q2 2026 liegt vor.'],
        ['datum', '2026-10-19'],
        ['mandantId', DEMO.seestern],
      ]),
    );
    expect(spec().mandantId).toBe(MANDANT);
    expect(spec().keinRecht).toBe('BEARBEITEN');
    const { d, r } = await lauf({ id: 'x', nummer: '2026-T-0401', folgen: 2 });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.ereignisErfassen, {
      body: {
        typ: 'T-05',
        quelle: 'MANUELL',
        titel: 'USt-Sonderprüfung angekündigt',
        beschreibung: 'Prüfungsanordnung für Q2 2026 liegt vor.',
        datum: '2026-10-19',
      },
    });
    expect(r).toEqual({ meldung: 'Ereignis 2026-T-0401 erfasst – 2 Folgen vorgeschlagen.' });
  });
});

describe('folgenAnlegenAction', () => {
  const felder: Array<[string, string]> = [
    ['folge', F_PROFIL],
    ['folge', F_KONTROLLE],
    ['zustaendig_' + F_PROFIL, `K:${DEMO.leon.toUpperCase()}`],
    ['zustaendig_' + F_KONTROLLE, `M:${DEMO.murat}`],
    ['frist_' + F_KONTROLLE, '2026-11-02'],
    ['zustaendig_' + F_RISIKO, `K:${DEMO.thomas}`],
    ['mandantId', DEMO.seestern],
  ];

  it('prüft jede Person beim gebundenen Mandanten vor dem Dienstaufruf', async () => {
    await folgenAnlegenAction(MANDANT, EREIGNIS, null, formular(felder));
    expect(spec().mandantId).toBe(MANDANT);
    const { d, r } = await lauf({
      folgen: [
        { folgeId: F_PROFIL, objektId: null, auswirkungHerabgestuft: false },
        { folgeId: F_KONTROLLE, objektId: 'd1', auswirkungHerabgestuft: false },
      ],
    });
    const bezug = { tenantId: DEMO.tenant, mandantId: MANDANT };
    expect(h.kanzlei).toHaveBeenCalledWith(TX, bezug, [DEMO.leon], {
      feld: `zustaendig_${F_PROFIL}`,
    });
    expect(h.kontakte).toHaveBeenCalledWith(TX, bezug, [DEMO.murat], {
      feld: `zustaendig_${F_KONTROLLE}`,
    });
    // Nicht gewählte Folge: deren Person wird weder geprüft noch gesendet.
    expect(h.kanzlei).not.toHaveBeenCalledWith(TX, bezug, [DEMO.thomas], expect.anything());
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.folgenAnlegen, {
      params: { ereignisId: EREIGNIS },
      body: {
        folgen: [
          { folgeId: F_PROFIL, frist: null, zustaendig: { id: DEMO.leon, art: 'KANZLEI' } },
          {
            folgeId: F_KONTROLLE,
            frist: '2026-11-02',
            zustaendig: { id: DEMO.murat, art: 'MANDANT' },
          },
        ],
      },
    });
    expect(r).toEqual({ meldung: '2 Folgen angelegt.' });
  });

  it('Person ohne Zugriff bzw. fremder Kontakt: Abbruch vor dem Dienstaufruf', async () => {
    h.kontakte.mockRejectedValue(new TcmsPersonUnzulaessig('KONTAKT', `zustaendig_${F_KONTROLLE}`));
    await folgenAnlegenAction(MANDANT, EREIGNIS, null, formular(felder));
    const s = spec();
    const p = s.parse!();
    await expect(s.vorbereiten!(TX, K, p.data)).rejects.toBeInstanceOf(TcmsPersonUnzulaessig);
  });

  it('unzulässiger Formularwert der Zuständigkeit: Abbruch ohne Personenabfrage', async () => {
    await folgenAnlegenAction(
      MANDANT,
      EREIGNIS,
      null,
      formular([
        ['folge', F_PROFIL],
        ['zustaendig_' + F_PROFIL, 'jemand@example.org'],
      ]),
    );
    const s = spec();
    await expect(s.vorbereiten!(TX, K, s.parse!().data)).rejects.toBeInstanceOf(
      TcmsPersonUnzulaessig,
    );
    expect(h.kanzlei).not.toHaveBeenCalled();
  });

  it('Feststellung unvollständig: Feldfehler an der Zeile, kein Dienstaufruf', async () => {
    await folgenAnlegenAction(
      MANDANT,
      EREIGNIS,
      null,
      formular([
        ['folge', F_RISIKO],
        ['ftitel_' + F_RISIKO, 'Kurz'],
      ]),
    );
    const p = spec().parse!();
    expect(p.ok).toBe(false);
    expect(p.fieldErrors).toHaveProperty(`ftitel_${F_RISIKO}`);
  });

  it('Feststellungstitel mit unzulässigen Zeichen (TCMS s8): Text des Vertrags an der Zeile', async () => {
    await folgenAnlegenAction(
      MANDANT,
      EREIGNIS,
      null,
      formular([
        ['folge', F_RISIKO],
        ['ftitel_' + F_RISIKO, `Lager CZ${String.fromCodePoint(0x200f)} prüfen`],
        ['fklasse_' + F_RISIKO, 'DURCHFUEHRUNGSMANGEL'],
        ['fschwere_' + F_RISIKO, 'MITTEL'],
        ['fauswirkung_' + F_RISIKO, 'UNKLAR'],
      ]),
    );
    const p = spec().parse!();
    expect(p.ok).toBe(false);
    expect(p.fieldErrors).toEqual({ [`ftitel_${F_RISIKO}`]: ['Unzulässige Zeichen'] });
  });

  it('Hinweis, wenn der Dienst die Auswirkung herabgestuft hat (TS-04)', async () => {
    await folgenAnlegenAction(MANDANT, EREIGNIS, null, formular([['folge', F_PROFIL]]));
    const { r } = await lauf({
      folgen: [{ folgeId: F_PROFIL, objektId: 'x', auswirkungHerabgestuft: true }],
    });
    expect(r).toEqual({ meldung: expect.stringContaining('„unklar“') });
  });
});

describe('Verwerfen mit Vier-Augen', () => {
  it('Antrag mit Begründung; Bestätigung mit Vier-Augen-Abbildung; Ablehnen bzw. Zurückziehen', async () => {
    await ereignisVerwerfenBeantragenAction(
      MANDANT,
      EREIGNIS,
      null,
      formular([['begruendung', BEGRUENDUNG]]),
    );
    expect(spec().keinRecht).toBe('BEARBEITEN');
    let { d } = await lauf({});
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.ereignisVerwerfenBeantragen, {
      params: { ereignisId: EREIGNIS },
      body: { begruendung: BEGRUENDUNG },
    });

    await ereignisVerwerfenBestaetigenAction(MANDANT, EREIGNIS, null, new FormData());
    expect(spec().keinRecht).toBe('VIER_AUGEN');
    expect(spec().mandantId).toBe(MANDANT);
    const verworfen = { id: EREIGNIS, nummer: '2026-T-0345', status: 'VERWORFEN' };
    ({ d } = await lauf(verworfen));
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.ereignisVerwerfenBestaetigen, {
      params: { ereignisId: EREIGNIS },
    });
    // Anlagen der Meldung: Freigabe mit der Antwort, nur dieses Ereignis des
    // gebundenen Mandanten, im Kontext der bestätigenden Person.
    expect(h.nachVerwerfen).toHaveBeenCalledWith(
      CTX,
      { mandantId: MANDANT, ereignisId: EREIGNIS },
      verworfen,
    );
    expect(h.nachVerwerfen.mock.invocationCallOrder[0]!).toBeGreaterThan(
      d.rufe.mock.invocationCallOrder[0]!,
    );

    await ereignisVerwerfenAblehnenAction(MANDANT, EREIGNIS, null, new FormData());
    const zurueck = await lauf({ zurueckgezogen: true });
    expect(zurueck.r).toEqual({ meldung: 'Antrag zurückgezogen.' });
    const abgelehnt = await lauf({ zurueckgezogen: false });
    expect(abgelehnt.r).toEqual({ meldung: 'Antrag auf Verwerfen abgelehnt.' });
  });

  it('Begründung zu kurz: Ablehnung im Parse', async () => {
    await ereignisVerwerfenBeantragenAction(
      MANDANT,
      EREIGNIS,
      null,
      formular([['begruendung', 'zu kurz']]),
    );
    expect(spec().parse!().ok).toBe(false);
  });
});

describe('übrige Triage-Schritte', () => {
  it('Pfad-IDs aus den gebundenen Argumenten; ungültige IDs ohne Dienstaufruf', async () => {
    await ereignisInPruefungNehmenAction(MANDANT, EREIGNIS, null, new FormData());
    let { d } = await lauf({});
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.ereignisInPruefungNehmen, {
      params: { ereignisId: EREIGNIS },
    });

    await folgeErledigenAction(MANDANT, EREIGNIS, F_PROFIL, null, new FormData());
    ({ d } = await lauf({}));
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.folgeErledigen, {
      params: { ereignisId: EREIGNIS, folgeId: F_PROFIL },
    });

    await folgeVerwerfenAction(
      MANDANT,
      EREIGNIS,
      F_RISIKO,
      null,
      formular([['begruendung', BEGRUENDUNG]]),
    );
    ({ d } = await lauf({}));
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.folgeVerwerfen, {
      params: { ereignisId: EREIGNIS, folgeId: F_RISIKO },
      body: { begruendung: BEGRUENDUNG },
    });

    await folgeHinzufuegenAction(
      MANDANT,
      EREIGNIS,
      null,
      formular([
        ['art', 'HINWEIS'],
        ['ziel', ''],
        ['text', 'Rücksprache mit der Geschäftsführung'],
      ]),
    );
    ({ d } = await lauf({}));
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.folgeHinzufuegen, {
      params: { ereignisId: EREIGNIS },
      body: { art: 'HINWEIS', ziel: null, text: 'Rücksprache mit der Geschäftsführung' },
    });

    await ereignisAbschliessenAction(MANDANT, EREIGNIS, null, new FormData());
    const { r } = await lauf({ nummer: '2026-T-0345' });
    expect(r).toEqual({ meldung: 'Ereignis 2026-T-0345 erledigt.' });

    await ereignisAbschliessenAction(MANDANT, '../x', null, new FormData());
    expect(spec().parse!().ok).toBe(false);
  });
});

describe('ungeklaerteAnlageZuordnenAction (kk-tcms-s10nach)', () => {
  const VERKNUEPFUNG = '0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d';
  const DOKUMENT = '5f0c7a1b-8e2d-4c3f-a1b0-9d8e7f6a5b4c';
  const SHA = 'ab'.repeat(32);
  const ANTWORT = {
    dokumentId: DOKUMENT.toUpperCase(),
    dateiname: 'kasse.csv',
    mime: 'text/csv',
    groesse: 812,
    sha256: SHA,
  };

  beforeEach(() => {
    h.ungeklaert.mockResolvedValue({ dokumentId: DOKUMENT, sha256: SHA });
    h.zuordnen.mockResolvedValue(true);
  });

  async function aufrufen(verknuepfung = VERKNUEPFUNG, ereignis = EREIGNIS) {
    await ungeklaerteAnlageZuordnenAction(
      MANDANT,
      verknuepfung,
      null,
      formular([
        ['ereignisId', ereignis],
        ['mandantId', DEMO.seestern],
        ['verknuepfungId', '11111111-1111-4111-8111-111111111111'],
      ]),
    );
  }

  it('nur Admin/Partner; Mandant und Verknüpfung aus den gebundenen Argumenten', async () => {
    await aufrufen();
    expect(spec()).toMatchObject({ mandantId: MANDANT, nurAdmin: true, keinRecht: 'VERWALTUNG' });
    expect(spec().parse!()).toEqual({
      ok: true,
      data: { verknuepfungId: VERKNUEPFUNG, ereignisId: EREIGNIS },
    });
    const v = await spec().vorbereiten!(TX, K, {
      verknuepfungId: VERKNUEPFUNG,
      ereignisId: EREIGNIS,
    });
    expect(h.ungeklaert).toHaveBeenCalledWith(TX, {
      tenantId: DEMO.tenant,
      mandantId: MANDANT,
      verknuepfungId: VERKNUEPFUNG,
    });
    expect(v).toMatchObject({ anlage: { dokumentId: DOKUMENT, sha256: SHA }, ctx: CTX });
  });

  it('ungültige Verknüpfung oder fehlendes Ereignis: abgewiesen vor jedem Aufruf', async () => {
    await aufrufen('keine-uuid');
    expect(spec().parse!()).toMatchObject({ ok: false });
    await aufrufen(VERKNUEPFUNG, '');
    expect(spec().parse!()).toMatchObject({ ok: false });
  });

  it('bestätigt das Tax-CMS die Anlage für dieses Ereignis, wird zugeordnet', async () => {
    await aufrufen();
    const { d, r } = await lauf(ANTWORT);
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.ereignisAnlageLesen, {
      params: { ereignisId: EREIGNIS, sha256: SHA },
    });
    expect(h.zuordnen).toHaveBeenCalledWith(CTX, {
      tenantId: DEMO.tenant,
      mandantId: MANDANT,
      verknuepfungId: VERKNUEPFUNG,
      ereignisId: EREIGNIS,
    });
    expect(r).toEqual({
      meldung: 'Die Anlage ist dem Ereignis zugeordnet und bleibt mit ihm verknüpft.',
    });
  });

  it('andere Dokument-ID oder Anlage im Ereignis unbekannt: nicht zugeordnet, Feldfehler', async () => {
    await aufrufen();
    const anderes = await lauf({ ...ANTWORT, dokumentId: 'e0f1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b' });
    expect(anderes.r).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { ereignisId: [expect.stringContaining('enthält die Anlage nicht')] },
    });
    // kk-tcms-fix4: Auch der SHA-256 der Antwort muss der Anlage entsprechen
    // (wie in der Datei-Route), nicht nur der angefragte Pfad.
    const andererHash = await lauf({ ...ANTWORT, sha256: 'cd'.repeat(32) });
    expect(andererHash.r).toMatchObject({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { ereignisId: [expect.stringContaining('enthält die Anlage nicht')] },
    });
    const s = spec();
    const v = await s.vorbereiten!(TX, K, { verknuepfungId: VERKNUEPFUNG, ereignisId: EREIGNIS });
    const fehlt = await s.aufruf(
      {
        rufe: vi.fn(async () => {
          throw new TcmsNichtGefunden({ status: 404 });
        }),
      },
      { verknuepfungId: VERKNUEPFUNG, ereignisId: EREIGNIS },
      v,
    );
    expect(fehlt).toMatchObject({ ok: false, errorCode: 'VALIDATION_ERROR' });
    expect(h.zuordnen).not.toHaveBeenCalled();
  });

  it('andere Fehler des Dienstes gehen an die Fehlerabbildung; nichts zugeordnet', async () => {
    await aufrufen();
    const s = spec();
    const v = await s.vorbereiten!(TX, K, { verknuepfungId: VERKNUEPFUNG, ereignisId: EREIGNIS });
    const fehler = new TcmsNichtVerfuegbar('STATUS', { status: 503 });
    await expect(
      s.aufruf(
        {
          rufe: vi.fn(async () => {
            throw fehler;
          }),
        },
        { verknuepfungId: VERKNUEPFUNG, ereignisId: EREIGNIS },
        v,
      ),
    ).rejects.toBe(fehler);
    expect(h.zuordnen).not.toHaveBeenCalled();
  });

  it('nicht mehr ungeklärt (vorher oder zwischenzeitlich geklärt): Konflikt, kein Aufruf bzw. keine Zuordnung', async () => {
    h.ungeklaert.mockResolvedValueOnce(null);
    await aufrufen();
    const { d, r } = await lauf(ANTWORT);
    expect(d.rufe).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
    h.zuordnen.mockResolvedValueOnce(false);
    const zwischendurch = await lauf(ANTWORT);
    expect(zwischendurch.r).toMatchObject({ ok: false, errorCode: 'CONFLICT' });
  });
});
