// TCMS Stufe 3, Bereich A: Verdrahtung des Einrichtungsassistenten
// (`einrichtungEntwurfSpeichern`, `programmAnlegen`). Ablauf, Gate und
// Fehlerabbildung testet server/tcms/__tests__/aktion.test.ts; hier: was die
// Aktion dem Helfer übergibt – Mandant aus dem gebundenen Argument, Schritt
// streng aus JSON gelesen, Personen der Kanzlei aus der kanzleikonsole statt
// aus dem Formular, Personen aus dem Formular vor dem Dienstaufruf geprüft,
// Weiterleitung nur nach Erfolg. kk-tcms-s11: Vor dem Anlegen (der Dienst
// versendet dann die Zielfreigabe) prüft die Aktion den gespeicherten
// Empfänger erneut (Kontakt mit aktivem Portalzugang).
// Fachkatalog: TCMS-AKTEUR-001, TCMS-DIENST-001
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  ergebnis: { ok: true } as Record<string, unknown>,
  zust: vi.fn(),
  freigabe: vi.fn(),
  kontrollen: vi.fn(),
  vorAnlegen: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return h.ergebnis;
  }),
}));
vi.mock('@/server/tcms/programm/zustaendigkeit', () => ({ tcmsZustaendigkeitTx: h.zust }));
vi.mock('@/server/tcms/programm/einrichtung', async (orig) => ({
  ...(await orig<typeof import('@/server/tcms/programm/einrichtung')>()),
  pruefeFreigabeEmpfaengerTx: h.freigabe,
  pruefeKontrollPersonenTx: h.kontrollen,
  pruefeZielfreigabeVorAnlegen: h.vorAnlegen,
}));

import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import { einrichtungSpeichernAction } from '../actions';

const MANDANT = 'a1000000-0000-4000-8000-000000004752';
const FREMD = 'a1000000-0000-4000-8000-000000004711';
const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const ANNA = 'b1000000-0000-4000-8000-000000000001';
const LEON = 'b1000000-0000-4000-8000-000000000002';
const THOMAS = 'b1000000-0000-4000-8000-000000000003';
const LEA = 'b1000000-0000-4000-8000-000000000051';
const TX = { tx: true };
const CTX = { tenantId: TENANT, actorId: ANNA, actorType: 'STAFF' };
const K = { g: { tenantId: TENANT, ctx: CTX }, akteur: {}, mandantId: MANDANT };
const BEZUG = { tenantId: TENANT, mandantId: MANDANT };
const ZUST = {
  berufstraeger: { id: ANNA, name: 'StB Dr. Anna Roth' },
  bearbeitung: { id: LEON, name: 'Leon Brandt' },
  kanzlei: [
    { id: ANNA, name: 'StB Dr. Anna Roth' },
    { id: LEON, name: 'Leon Brandt' },
    { id: THOMAS, name: 'Thomas Kühn' },
  ],
  vertretung: { id: THOMAS, name: 'Thomas Kühn' },
};

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse: () => {
    ok: boolean;
    data?: unknown;
    error?: string;
    fieldErrors?: Record<string, string[]>;
  };
  vorbereiten: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

function dienst(antwort: unknown = {}) {
  return { rufe: vi.fn(async () => ({ daten: antwort, requestId: 'r' })) };
}

function formular(schritt: number | string, ziel: string, daten: unknown): FormData {
  const fd = new FormData();
  fd.set('schritt', String(schritt));
  fd.set('ziel', ziel);
  fd.set('daten', typeof daten === 'string' ? daten : JSON.stringify(daten));
  // Versuch, Mandant und Personen über das Formular unterzuschieben: ignoriert.
  fd.set('mandantId', FREMD);
  fd.set('personen', JSON.stringify({ berufstraegerId: LEA, bearbeitungId: LEA, kanzlei: [LEA] }));
  return fd;
}

function entwurf() {
  const e = tcmsFixtures.einrichtungBergkamm().entwurf!;
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.ergebnis = { ok: true };
  h.zust.mockResolvedValue(ZUST);
  h.freigabe.mockResolvedValue(undefined);
  h.kontrollen.mockResolvedValue(undefined);
  h.vorAnlegen.mockResolvedValue(undefined);
});

describe('einrichtungSpeichernAction', () => {
  it('Schritt 1 speichern: Mandant gebunden, Personen der kanzleikonsole, Body des Entwurfs', async () => {
    const e = entwurf();
    const daten = { teilbereich: e.teilbereich, zeitraum: e.zeitraum };
    await einrichtungSpeichernAction(MANDANT, null, formular(1, 'speichern', daten));
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('BEARBEITEN');
    // Feldfehler des Dienstes betreffen den ganzen Schritt: nur Sammelmeldung.
    expect(s.felder).toEqual({});
    const parsed = s.parse();
    expect(parsed.ok).toBe(true);

    const v = await s.vorbereiten(TX, K, parsed.data);
    expect(h.zust).toHaveBeenCalledWith(TX, { tenantId: TENANT, mandantId: MANDANT });
    const personen = { berufstraegerId: ANNA, bearbeitungId: LEON, kanzlei: [ANNA, LEON, THOMAS] };
    expect(v).toEqual({ personen, ctx: CTX, bezug: BEZUG });
    // Schritt 1: weder Freigabeempfänger noch Kontrollpersonen zu prüfen.
    expect(h.freigabe).not.toHaveBeenCalled();
    expect(h.kontrollen).not.toHaveBeenCalled();

    const d = dienst({ programmId: 'p', angelegt: false, abgeschlossen: 4, geaendert: true });
    await expect(s.aufruf(d, parsed.data, v)).resolves.toEqual({
      ziel: 'speichern',
      schritt: 1,
      meldung: 'Entwurf gespeichert.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.einrichtungEntwurfSpeichern, {
      body: { schritt: 1, ziel: 'speichern', daten, personen },
    });
    // „speichern“ bleibt auf der Seite.
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('ohne Änderung meldet die Aktion das statt „gespeichert“', async () => {
    const e = entwurf();
    await einrichtungSpeichernAction(
      MANDANT,
      null,
      formular(1, 'speichern', { teilbereich: e.teilbereich, zeitraum: e.zeitraum }),
    );
    const s = spec();
    const parsed = s.parse();
    const d = dienst({ programmId: 'p', angelegt: false, abgeschlossen: 4, geaendert: false });
    await expect(
      s.aufruf(d, parsed.data, { personen: {}, ctx: CTX, bezug: BEZUG }),
    ).resolves.toMatchObject({
      meldung: 'Keine Änderungen – der Entwurf ist unverändert.',
    });
  });

  it('Schritt 3 prüft den Empfänger der Zielfreigabe beim Mandanten der Aktion', async () => {
    const e = entwurf();
    const daten = { ziele: e.ziele, freigabe: { anfordern: true, empfaengerId: LEA } };
    await einrichtungSpeichernAction(MANDANT, null, formular(3, 'weiter', daten));
    const s = spec();
    const parsed = s.parse();
    expect(parsed.ok).toBe(true);
    await s.vorbereiten(TX, K, parsed.data);
    expect(h.freigabe).toHaveBeenCalledWith(
      TX,
      { tenantId: TENANT, mandantId: MANDANT },
      { anfordern: true, empfaengerId: LEA },
    );
    expect(h.kontrollen).not.toHaveBeenCalled();
  });

  it('eine abgelehnte Person verhindert den Dienstaufruf (Fehler aus vorbereiten)', async () => {
    const e = entwurf();
    const fehler = new Error('Person unzulässig');
    h.freigabe.mockRejectedValueOnce(fehler);
    await einrichtungSpeichernAction(
      MANDANT,
      null,
      formular(3, 'speichern', {
        ziele: e.ziele,
        freigabe: { anfordern: true, empfaengerId: LEA },
      }),
    );
    const s = spec();
    await expect(s.vorbereiten(TX, K, s.parse().data)).rejects.toBe(fehler);
  });

  it('Schritt 5 prüft alle Personen der Zuständigkeiten, „anlegen“ ruft programmAnlegen', async () => {
    const plan = tcmsFixtures.einrichtungBergkamm().plan!;
    const kontrollen = Object.fromEntries(
      plan.kontrollen.map((k) => [
        k.code,
        {
          partei: k.zust.partei,
          durchfuehrendId: k.zust.durchfuehrendId,
          vertretungId: k.zust.vertretungId,
          gegenzeichnerId: k.zust.gegenzeichnerId,
        },
      ]),
    );
    h.ergebnis = { ok: true, ziel: 'anlegen', schritt: 5, meldung: 'x' };
    await expect(
      einrichtungSpeichernAction(MANDANT, null, formular(5, 'anlegen', { kontrollen })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(h.redirect).toHaveBeenCalledWith(`/staff/clients/${MANDANT}/tcms/einrichtung`);
    const s = spec();
    const parsed = s.parse();
    expect(parsed.ok).toBe(true);
    const v = (await s.vorbereiten(TX, K, parsed.data)) as { personen: unknown };
    expect(h.kontrollen).toHaveBeenCalledWith(
      TX,
      { tenantId: TENANT, mandantId: MANDANT },
      kontrollen,
    );
    const d = dienst({
      programmId: 'p',
      risiken: 1,
      abgelehnt: 0,
      kontrollen: 1,
      durchfuehrungen: 1,
    });
    await expect(s.aufruf(d, parsed.data, v)).resolves.toMatchObject({
      ziel: 'anlegen',
      meldung: 'Version 1 des Tax-CMS ist angelegt.',
    });
    // kk-tcms-s11: zuerst den Entwurf lesen (Empfänger der Zielfreigabe), dann anlegen.
    expect(d.rufe.mock.calls).toEqual([
      [ENDPUNKTE.einrichtungLesen, { query: {} }],
      [ENDPUNKTE.programmAnlegen, { body: { daten: { kontrollen }, personen: v.personen } }],
    ]);
    // Ohne angeforderte Freigabe im Entwurf: keine erneute Prüfung.
    expect(h.vorAnlegen).not.toHaveBeenCalled();
  });

  describe('kk-tcms-s11: Empfänger der Zielfreigabe vor dem Anlegen erneut prüfen', () => {
    const kontrollen = {};
    async function anlegen(freigabe: { anfordern: boolean; empfaengerId: string | null }) {
      h.ergebnis = { ok: false, error: 'x' };
      await einrichtungSpeichernAction(MANDANT, null, formular(5, 'anlegen', { kontrollen }));
      const s = spec();
      const parsed = s.parse();
      const v = await s.vorbereiten(TX, K, parsed.data);
      const view = { ...tcmsFixtures.einrichtungBergkamm() };
      view.entwurf = { ...view.entwurf!, freigabe };
      const rufe = vi.fn(async (endpunkt: { name?: string }) => ({
        daten: endpunkt === ENDPUNKTE.einrichtungLesen ? view : { programmId: 'p' },
        requestId: 'r',
      }));
      return { r: await s.aufruf({ rufe }, parsed.data, v), rufe };
    }

    it('Freigabe angefordert: Empfänger mit Kontext und Mandant der Aktion geprüft, dann angelegt', async () => {
      const freigabe = { anfordern: true, empfaengerId: LEA };
      const { r, rufe } = await anlegen(freigabe);
      expect(h.vorAnlegen).toHaveBeenCalledWith(CTX, BEZUG, freigabe);
      expect(r).toMatchObject({ meldung: 'Version 1 des Tax-CMS ist angelegt.' });
      expect(rufe).toHaveBeenLastCalledWith(ENDPUNKTE.programmAnlegen, expect.anything());
    });

    it('Empfänger ohne Portalzugang (bzw. nicht mehr beim Mandanten): fester Text, kein Anlegen', async () => {
      const { TcmsPersonUnzulaessig, TCMS_PERSON_UNZULAESSIG_TEXTE } =
        await import('@/server/tcms/personen');
      h.vorAnlegen.mockRejectedValueOnce(new TcmsPersonUnzulaessig('PORTAL', 'freigabe'));
      const { r, rufe } = await anlegen({ anfordern: true, empfaengerId: LEA });
      expect(r).toEqual({
        ok: false,
        error: `Schritt 3 (Freigabe der Ziele): ${TCMS_PERSON_UNZULAESSIG_TEXTE.PORTAL}`,
        errorCode: 'VALIDATION_ERROR',
      });
      expect(rufe).toHaveBeenCalledTimes(1);
      expect(rufe).not.toHaveBeenCalledWith(ENDPUNKTE.programmAnlegen, expect.anything());
    });

    it('andere Fehler der Prüfung gehen an die Fehlerabbildung; kein Anlegen', async () => {
      const fehler = new Error('Datenbank');
      h.vorAnlegen.mockRejectedValueOnce(fehler);
      await expect(anlegen({ anfordern: true, empfaengerId: LEA })).rejects.toBe(fehler);
    });

    it('nicht angefordert bzw. ohne Empfänger: keine Prüfung', async () => {
      await anlegen({ anfordern: false, empfaengerId: LEA });
      await anlegen({ anfordern: true, empfaengerId: null });
      expect(h.vorAnlegen).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['weiter', 2, '?schritt=3'],
    ['zurueck', 2, '?schritt=1'],
    ['weiter', 5, '?schritt=5'],
  ])('leitet nach Erfolg weiter (%s ab Schritt %i)', async (ziel, schritt, suffix) => {
    h.ergebnis = { ok: true, ziel, schritt, meldung: 'x' };
    const e = entwurf();
    await expect(
      einrichtungSpeichernAction(MANDANT, null, formular(2, ziel, { profil: e.profil })),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(h.redirect).toHaveBeenCalledWith(`/staff/clients/${MANDANT}/tcms/einrichtung${suffix}`);
  });

  it('ohne Erfolg keine Weiterleitung, das Ergebnis geht an das Formular', async () => {
    h.ergebnis = { ok: false, error: 'Fehler', errorCode: 'VALIDATION_ERROR' };
    const e = entwurf();
    await expect(
      einrichtungSpeichernAction(MANDANT, null, formular(2, 'weiter', { profil: e.profil })),
    ).resolves.toEqual(h.ergebnis);
    expect(h.redirect).not.toHaveBeenCalled();
  });

  describe('Eingabeprüfung vor jedem Zugriff', () => {
    async function parse(fd: FormData) {
      await einrichtungSpeichernAction(MANDANT, null, fd);
      return spec().parse();
    }

    it('„anlegen“ nur im letzten Schritt', async () => {
      const e = entwurf();
      const r = await parse(formular(4, 'anlegen', { risiken: e.risiken }));
      expect(r).toMatchObject({ ok: false, error: 'Version 1 wird im letzten Schritt angelegt.' });
    });

    it('doppelte JSON-Schlüssel werden nicht stillschweigend aufgelöst', async () => {
      const r = await parse(
        formular(
          3,
          'speichern',
          '{"ziele":[],"freigabe":{"anfordern":false,"empfaengerId":null},"ziele":[]}',
        ),
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('konnten nicht gelesen werden');
    });

    it('Daten anderer Schritte bzw. fremde Felder scheitern am Schema des Schritts', async () => {
      const e = entwurf();
      expect((await parse(formular(1, 'speichern', { profil: e.profil }))).ok).toBe(false);
      expect(
        (
          await parse(
            formular(3, 'speichern', {
              ziele: e.ziele,
              freigabe: { anfordern: true, empfaengerId: 'keine-uuid' },
            }),
          )
        ).ok,
      ).toBe(false);
      expect(
        (
          await parse(
            formular(1, 'speichern', {
              teilbereich: e.teilbereich,
              zeitraum: e.zeitraum,
              personen: { berufstraegerId: LEA },
            }),
          )
        ).ok,
      ).toBe(false);
    });

    it.each([
      ['0', 'speichern'],
      ['6', 'speichern'],
      ['1', 'loeschen'],
    ])('Schritt %s / Ziel %s: ungültig', async (schritt, ziel) => {
      expect((await parse(formular(schritt, ziel, {}))).ok).toBe(false);
    });

    it('übergroße Daten werden vor dem Lesen abgewiesen', async () => {
      const r = await parse(formular(2, 'speichern', 'x'.repeat(400_001)));
      expect(r.ok).toBe(false);
    });
  });
});
