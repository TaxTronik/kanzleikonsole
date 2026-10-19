// TCMS Stufe 3, Bereich C: Verdrahtung der Aktionen der Kontrolldurchführung.
// Ablauf, Gate und Fehlerabbildung testet server/tcms/__tests__/aktion.test.ts;
// hier: Mandant und Durchführung aus den gebundenen Argumenten, Endpunkt und
// Body des Dienstaufrufs, Nachweise nur über die Bausteine der kanzleikonsole.
// Fachkatalog: TCMS-NACHWEIS-001
import { ENDPUNKTE } from '@taxtronik/tcms-contract';
import { TcmsNichtVerfuegbar, TcmsUngueltig } from '@taxtronik/tcms-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spec: null as null | Record<string, unknown>,
  revalidiere: vi.fn(),
  redirect: vi.fn((ziel: string) => {
    throw new Error(`NEXT_REDIRECT:${ziel}`);
  }),
  quelle: vi.fn(),
  vorpruefung: vi.fn(),
  ablegen: vi.fn(),
  verknuepfen: vi.fn(),
  anhaengen: vi.fn(),
  entfernen: vi.fn(),
  nichtAngehaengt: vi.fn((_f: unknown, _e: string) => new Error('NICHT_ANGEHAENGT')),
  ergebnis: { ok: true } as Record<string, unknown>,
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/server/tcms/aktion', () => ({
  tcmsKanzleiAktion: vi.fn(async (spec: Record<string, unknown>) => {
    h.spec = spec;
    return h.ergebnis;
  }),
  revalidiereTcmsMandant: h.revalidiere,
}));
vi.mock('@/server/tcms/durchfuehrung/verweis', () => ({ nachweisQuelleTx: h.quelle }));
vi.mock('@/server/tcms/durchfuehrung/nachweis-aktion', async () => {
  const { createHash } = await import('node:crypto');
  return {
    nachweisVorpruefung: h.vorpruefung,
    nachweisDateiAblegen: h.ablegen,
    nachweisDokumentVerknuepfen: h.verknuepfen,
    nachweisAnhaengenUndBinden: h.anhaengen,
    nachweisEntfernenUndFreigeben: h.entfernen,
    nachweisNichtAngehaengt: h.nichtAngehaengt,
    sha256Hex: (b: Buffer) => createHash('sha256').update(b).digest('hex'),
    vorhandenerNachweis: (
      d: { nachweise: Array<{ sha256: string; dokumentId: string; dateiname: string }> },
      m: { sha256?: string; dokumentId?: string },
    ) =>
      d.nachweise.find((n) => n.sha256 === m.sha256 || n.dokumentId === m.dokumentId)?.dateiname ??
      null,
  };
});

import { tcmsFixtures } from '@/__tests__/tcms-fixtures';
import * as aktionen from '../[did]/actions';

const MANDANT = 'a1000000-0000-4000-8000-000000004711';
const TENANT = '7a1e0000-0000-4000-8000-00000000d3e0';
const STAFF = 'b1000000-0000-4000-8000-000000000002';
const DID = 'cmvf9pzy3003jfu7d4oo44g6s';
const CTX = { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' };
const K = {
  g: { tenantId: TENANT, staffId: STAFF, ctx: CTX, session: {} },
  akteur: {},
  mandantId: MANDANT,
};
const BEGRUENDUNG = 'Keine Umsätze im September, Shop war geschlossen.';

interface Spec {
  mandantId: string | null;
  keinRecht?: string;
  felder?: Record<string, string>;
  parse?: () => { ok: boolean; data?: unknown; fieldErrors?: Record<string, string[]> };
  vorbereiten?: (tx: unknown, k: unknown, data: unknown) => Promise<unknown>;
  aufruf: (dienst: unknown, data: unknown, vorbereitet: unknown) => Promise<unknown>;
}

function spec(): Spec {
  expect(h.spec).not.toBeNull();
  return h.spec as unknown as Spec;
}

type Rufe = ReturnType<typeof vi.fn>;
function dienst(antworten: Record<string, unknown> = {}): { rufe: Rufe } {
  return {
    rufe: vi.fn(async (endpunkt: { name: string }) => {
      const a = antworten[endpunkt.name];
      if (a instanceof Error) throw a;
      return { daten: a ?? {}, requestId: 'r' };
    }),
  };
}

function formular(felder: Array<[string, string | File]>): FormData {
  const fd = new FormData();
  for (const [k, v] of felder) fd.append(k, v);
  return fd;
}

async function geparst(): Promise<unknown> {
  const p = spec().parse!();
  expect(p.ok).toBe(true);
  return p.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.spec = null;
  h.ergebnis = { ok: true };
});

describe('Beginnen, Entfallen, Zurückweisen, Gegenzeichnen', () => {
  it('beginnen: Mandant und Durchführung aus den gebundenen Argumenten', async () => {
    await aktionen.durchfuehrungBeginnenAction(MANDANT, DID, null, formular([['mandantId', 'x']]));
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    expect(s.keinRecht).toBe('DURCHFUEHREN');
    const d = dienst();
    await expect(s.aufruf(d, undefined, undefined)).resolves.toEqual({
      meldung: 'Durchführung begonnen.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.durchfuehrungBeginnen, {
      params: { durchfuehrungId: DID },
    });
  });

  it('ungültige gebundene Durchführung: kein Dienstaufruf', async () => {
    await aktionen.durchfuehrungBeginnenAction(MANDANT, '../x', null, formular([]));
    const d = dienst();
    await expect(spec().aufruf(d, undefined, undefined)).rejects.toThrow(
      'Durchführung nicht gefunden.',
    );
    expect(d.rufe).not.toHaveBeenCalled();
  });

  it('Begründung unter 30 Zeichen: Feldfehler ohne Dienstaufruf', async () => {
    await aktionen.durchfuehrungZurueckweisenAction(
      MANDANT,
      DID,
      null,
      formular([['begruendung', 'zu kurz']]),
    );
    const p = spec().parse!();
    expect(p.ok).toBe(false);
    expect(p.fieldErrors?.begruendung?.[0]).toMatch(/mindestens 30 Zeichen/);
    expect(spec().keinRecht).toBe('GEGENZEICHNEN');
  });

  it('zurückweisen, entfallen beantragen: Begründung im Body', async () => {
    for (const [aktion, endpunkt] of [
      [aktionen.durchfuehrungZurueckweisenAction, ENDPUNKTE.durchfuehrungZurueckweisen],
      [aktionen.entfallenBeantragenAction, ENDPUNKTE.entfallenBeantragen],
    ] as const) {
      await aktion(MANDANT, DID, null, formular([['begruendung', `  ${BEGRUENDUNG}  `]]));
      const d = dienst();
      await spec().aufruf(d, await geparst(), undefined);
      expect(d.rufe).toHaveBeenCalledWith(endpunkt, {
        params: { durchfuehrungId: DID },
        body: { begruendung: BEGRUENDUNG },
      });
    }
  });

  it('Entfallen ablehnen mit Begründung, zurückziehen ohne', async () => {
    await aktionen.entfallenAblehnenAction(MANDANT, DID, null, formular([]));
    let d = dienst();
    await expect(spec().aufruf(d, await geparst(), undefined)).resolves.toEqual({
      meldung: 'Antrag zurückgezogen.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.entfallenAblehnen, {
      params: { durchfuehrungId: DID },
      body: {},
    });
    await aktionen.entfallenAblehnenAction(
      MANDANT,
      DID,
      null,
      formular([['begruendung', BEGRUENDUNG]]),
    );
    d = dienst();
    await expect(spec().aufruf(d, await geparst(), undefined)).resolves.toEqual({
      meldung: 'Antrag abgelehnt.',
    });
    expect(spec().keinRecht).toBe('VIER_AUGEN');
  });

  it('gegenzeichnen ohne Befund: leerer Body; mit Befund: Feststellung nach Vertrag', async () => {
    await aktionen.durchfuehrungGegenzeichnenAction(MANDANT, DID, null, formular([]));
    let d = dienst({
      durchfuehrungGegenzeichnen: {
        durchfuehrungId: DID,
        status: 'OHNE_BEFUND',
        feststellung: null,
      },
    });
    await expect(spec().aufruf(d, await geparst(), undefined)).resolves.toEqual({
      meldung: 'Gegengezeichnet – abgeschlossen ohne Befund.',
    });
    expect(d.rufe).toHaveBeenCalledWith(ENDPUNKTE.durchfuehrungGegenzeichnen, {
      params: { durchfuehrungId: DID },
      body: {},
    });

    await aktionen.durchfuehrungGegenzeichnenAction(
      MANDANT,
      DID,
      null,
      formular([
        ['fTitel', 'Restsaldo Klarna'],
        ['fSachverhalt', 'Clearingkonto mit Restsaldo zum Monatsende.'],
        ['fKlasse', 'DURCHFUEHRUNGSMANGEL'],
        ['fSchwere', 'GERING'],
        ['fAuswirkung', 'UNKLAR'],
        ['fRisiko', 'cmvf9pzjt000bfu7d577g29ub'],
        ['fRisiko', 'cmvf9pzjt000bfu7d577g29ub'],
      ]),
    );
    d = dienst({
      durchfuehrungGegenzeichnen: {
        durchfuehrungId: DID,
        status: 'MIT_BEFUND',
        feststellung: { id: 'f', nummer: 'F-2026-008' },
      },
    });
    await expect(spec().aufruf(d, await geparst(), undefined)).resolves.toEqual({
      meldung: 'Gegengezeichnet – abgeschlossen mit Befund (Feststellung F-2026-008).',
    });
    expect(d.rufe.mock.calls[0]![1]).toEqual({
      params: { durchfuehrungId: DID },
      body: {
        feststellung: {
          titel: 'Restsaldo Klarna',
          sachverhalt: 'Clearingkonto mit Restsaldo zum Monatsende.',
          klasse: 'DURCHFUEHRUNGSMANGEL',
          schwere: 'GERING',
          auswirkung: 'UNKLAR',
          risikoIds: ['cmvf9pzjt000bfu7d577g29ub'],
        },
      },
    });
  });

  it('gegenzeichnen mit unvollständigem Befund: Fehler am Formularfeld', async () => {
    await aktionen.durchfuehrungGegenzeichnenAction(
      MANDANT,
      DID,
      null,
      formular([
        ['fTitel', 'Rest'],
        ['fSachverhalt', 'kurz'],
      ]),
    );
    const p = spec().parse!();
    expect(p.ok).toBe(false);
    expect(Object.keys(p.fieldErrors ?? {})).toEqual(
      expect.arrayContaining([
        'fTitel',
        'fSachverhalt',
        'fKlasse',
        'fSchwere',
        'fAuswirkung',
        'fRisiko',
      ]),
    );
  });

  it('Nachtrag: nach Erfolg zur neuen Durchführung, ohne Erfolg keine Weiterleitung', async () => {
    h.ergebnis = { ok: true, neu: 'cneu000000000000000000001' };
    await expect(
      aktionen.nachtragAnlegenAction(MANDANT, DID, null, formular([['begruendung', BEGRUENDUNG]])),
    ).rejects.toThrow(
      `NEXT_REDIRECT:/staff/clients/${MANDANT}/tcms/durchfuehrungen/cneu000000000000000000001`,
    );
    const d = dienst({
      nachtragAnlegen: { durchfuehrungId: 'cneu000000000000000000001', nachtragZuId: DID },
    });
    await expect(spec().aufruf(d, await geparst(), undefined)).resolves.toEqual({
      neu: 'cneu000000000000000000001',
    });
    h.ergebnis = { ok: false, error: 'Wurde zwischenzeitlich geändert – bitte neu laden.' };
    h.redirect.mockClear();
    await expect(
      aktionen.nachtragAnlegenAction(MANDANT, DID, null, formular([['begruendung', BEGRUENDUNG]])),
    ).resolves.toEqual(h.ergebnis);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});

describe('Speichern und Einreichen', () => {
  const lesen = () => {
    const d = tcmsFixtures.durchfuehrungInDurchfuehrung();
    d.kontrolle.kennzahlen = [
      { key: 'saldo', label: 'Saldo Clearingkonto', sollEur: 0 },
      { key: 'shop', label: 'Shop', sollEur: null },
      { key: 'diff', label: 'Differenz', sollEur: null, differenzAus: ['saldo', 'shop'] },
    ];
    return d;
  };
  const eingabe = (absicht: string, wert = '1.234,56') =>
    formular([
      ['schritt_0_erledigt', 'on'],
      ['schritt_0_kommentar', ' geprüft '],
      ['schritt_7_erledigt', 'on'],
      ['wert_saldo', wert],
      ['wert_shop', ''],
      ['bemerkung_saldo', 'Rundung'],
      ['erklaert_saldo', 'on'],
      ['ergebnis', 'OHNE_BEFUND'],
      ['ergebnisKommentar', ''],
      ['absicht', absicht],
    ]);

  it('Struktur aus dem Dienst, Eingaben aus dem Formular', async () => {
    await aktionen.durchfuehrungSpeichernAction(MANDANT, DID, null, eingabe('speichern'));
    const d = dienst({
      durchfuehrungLesen: lesen(),
      durchfuehrungSpeichern: { pruefung: { maengel: [] } },
    });
    await expect(spec().aufruf(d, undefined, undefined)).resolves.toEqual({
      meldung: 'Entwurf gespeichert.',
    });
    expect(d.rufe.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual([
      'durchfuehrungLesen',
      'durchfuehrungSpeichern',
    ]);
    expect(d.rufe.mock.calls[1]![1]).toEqual({
      params: { durchfuehrungId: DID },
      body: {
        schritte: [
          { erledigt: true, kommentar: 'geprüft' },
          { erledigt: false, kommentar: '' },
          { erledigt: false, kommentar: '' },
        ],
        werte: [
          { key: 'saldo', wert: 1234.56, bemerkung: 'Rundung', erklaert: true },
          { key: 'shop', wert: null, bemerkung: '', erklaert: false },
          { key: 'diff', wert: null, bemerkung: '', erklaert: false },
        ],
        ergebnis: 'OHNE_BEFUND',
        ergebnisKommentar: null,
      },
    });
  });

  it('unlesbarer Betrag: Feldfehler, nichts gespeichert', async () => {
    await aktionen.durchfuehrungSpeichernAction(MANDANT, DID, null, eingabe('speichern', '12x'));
    const d = dienst({ durchfuehrungLesen: lesen() });
    const r = (await spec().aufruf(d, undefined, undefined)) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false, fieldErrors: { wert_saldo: [expect.any(String)] } });
    expect(d.rufe).toHaveBeenCalledTimes(1);
  });

  it('einreichen nach dem Speichern; Ablehnung des Dienstes nennt die Mängel des gespeicherten Stands', async () => {
    await aktionen.durchfuehrungSpeichernAction(MANDANT, DID, null, eingabe('einreichen'));
    let d = dienst({
      durchfuehrungLesen: lesen(),
      durchfuehrungSpeichern: { pruefung: { maengel: [] } },
    });
    await expect(spec().aufruf(d, undefined, undefined)).resolves.toEqual({
      meldung: 'Zur Gegenzeichnung eingereicht. Die Nachweise sind jetzt gesperrt.',
    });
    expect(d.rufe.mock.calls[2]![0]).toBe(ENDPUNKTE.durchfuehrungEinreichen);

    d = dienst({
      durchfuehrungLesen: lesen(),
      durchfuehrungSpeichern: { pruefung: { maengel: ['2 von 3 Schritten offen'] } },
      durchfuehrungEinreichen: new TcmsUngueltig(
        { maengel: ['Text des Dienstes'] },
        { status: 400 },
      ),
    });
    await expect(spec().aufruf(d, undefined, undefined)).resolves.toEqual({
      ok: false,
      errorCode: 'VALIDATION_ERROR',
      error: 'Entwurf gespeichert, aber noch nicht eingereicht: 2 von 3 Schritten offen.',
    });
    expect(h.revalidiere).toHaveBeenCalledWith(MANDANT);

    // Andere Fehler beim Einreichen gehen an die Fehlerabbildung des Helfers.
    const aus = new TcmsNichtVerfuegbar('ZEITLIMIT');
    d = dienst({
      durchfuehrungLesen: lesen(),
      durchfuehrungSpeichern: { pruefung: { maengel: [] } },
      durchfuehrungEinreichen: aus,
    });
    await expect(spec().aufruf(d, undefined, undefined)).rejects.toBe(aus);
  });
});

describe('Nachweise', () => {
  const datei = () =>
    new File([Buffer.from('%PDF-1.4 Nachweis')], 'Liste.pdf', { type: 'application/pdf' });

  it('Auswahl: Dokument nur über nachweisQuelleTx dieses Mandanten, Verknüpfung vor dem Anhängen', async () => {
    const DOK = 'c3000000-0000-4000-8000-000000000009';
    await aktionen.nachweisAuswaehlenAction(
      MANDANT,
      DID,
      null,
      formular([['dokumentId', DOK.toUpperCase()]]),
    );
    const s = spec();
    expect(s.mandantId).toBe(MANDANT);
    h.quelle.mockResolvedValue({ verweis: { dokumentId: DOK } });
    const v = await s.vorbereiten!({ tx: 1 }, K, await geparst());
    expect(h.quelle).toHaveBeenCalledWith(
      { tx: 1 },
      { tenantId: TENANT, mandantId: MANDANT, staffId: STAFF },
      DOK.toUpperCase(),
    );
    h.vorpruefung.mockResolvedValue({ nachweise: [] });
    h.verknuepfen.mockResolvedValue({ verknuepfungId: 'v1', verweis: {} });
    const d = dienst();
    await expect(s.aufruf(d, undefined, v)).resolves.toEqual({
      meldung: 'Dokument als Nachweis angehängt.',
    });
    expect(h.verknuepfen).toHaveBeenCalledWith(
      CTX,
      { tenantId: TENANT, mandantId: MANDANT, staffId: STAFF },
      DOK,
      DID,
    );
    expect(h.anhaengen).toHaveBeenCalledWith(d, CTX, DID, { verknuepfungId: 'v1', verweis: {} });
  });

  it('Auswahl eines bereits angehängten Dokuments: keine Verknüpfung, kein Anhängen', async () => {
    const DOK = 'c3000000-0000-4000-8000-000000000001';
    await aktionen.nachweisAuswaehlenAction(MANDANT, DID, null, formular([['dokumentId', DOK]]));
    h.vorpruefung.mockResolvedValue(tcmsFixtures.durchfuehrungInDurchfuehrung());
    const r = await spec().aufruf(dienst(), undefined, { ctx: CTX, bezug: {}, dokumentId: DOK });
    expect(r).toMatchObject({
      ok: false,
      error: 'Bereits als Nachweis angehängt: Kontoabstimmung September.pdf.',
    });
    expect(h.verknuepfen).not.toHaveBeenCalled();
    expect(h.anhaengen).not.toHaveBeenCalled();
  });

  it('Upload: Datei Pflicht; Ablage über die Pipeline, danach Anhängen mit dem gespeicherten Verweis', async () => {
    await aktionen.nachweisHochladenAction(MANDANT, DID, null, formular([]));
    expect(spec().parse!()).toMatchObject({
      ok: false,
      fieldErrors: { datei: ['Bitte eine Datei auswählen.'] },
    });

    await aktionen.nachweisHochladenAction(MANDANT, DID, null, formular([['datei', datei()]]));
    const s = spec();
    const v = await s.vorbereiten!({}, K, await geparst());
    expect(v).toEqual({ g: K.g, bezug: { tenantId: TENANT, mandantId: MANDANT, staffId: STAFF } });
    h.vorpruefung.mockResolvedValue({ nachweise: [] });
    h.ablegen.mockResolvedValue({
      verknuepfungId: 'v2',
      verweis: { dokumentId: 'neu' },
      dokumentId: 'neu',
    });
    const d = dienst();
    await expect(s.aufruf(d, undefined, v)).resolves.toEqual({
      meldung: 'Datei hochgeladen und als Nachweis angehängt.',
    });
    const [g, bezug, did, inhalt] = h.ablegen.mock.calls[0]!;
    expect([g, bezug, did]).toEqual([
      K.g,
      { tenantId: TENANT, mandantId: MANDANT, staffId: STAFF },
      DID,
    ]);
    expect(inhalt).toMatchObject({ fileName: 'Liste.pdf' });
    expect(h.anhaengen).toHaveBeenCalledWith(
      d,
      CTX,
      DID,
      expect.objectContaining({ verknuepfungId: 'v2' }),
    );
    // Vorprüfung vor der Ablage.
    expect(h.vorpruefung.mock.invocationCallOrder[0]!).toBeLessThan(
      h.ablegen.mock.invocationCallOrder[0]!,
    );
  });

  it('Upload gleichen Inhalts: keine Ablage', async () => {
    await aktionen.nachweisHochladenAction(MANDANT, DID, null, formular([['datei', datei()]]));
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(Buffer.from('%PDF-1.4 Nachweis')).digest('hex');
    h.vorpruefung.mockResolvedValue({
      nachweise: [{ sha256: sha, dokumentId: 'x', dateiname: 'Liste alt.pdf' }],
    });
    const r = await spec().aufruf(dienst(), undefined, { g: K.g, bezug: {} });
    expect(r).toMatchObject({ ok: false, error: 'Bereits vorhanden: Liste alt.pdf.' });
    expect(h.ablegen).not.toHaveBeenCalled();
  });

  it('Upload, aber Anhängen abgelehnt: Meldung mit Hinweis auf die Ablage', async () => {
    await aktionen.nachweisHochladenAction(MANDANT, DID, null, formular([['datei', datei()]]));
    h.vorpruefung.mockResolvedValue({ nachweise: [] });
    h.ablegen.mockResolvedValue({ verknuepfungId: 'v3', verweis: {}, dokumentId: 'neu' });
    const fehler = new Error('abgelehnt');
    h.anhaengen.mockRejectedValue(fehler);
    await expect(spec().aufruf(dienst(), undefined, { g: K.g, bezug: {} })).rejects.toThrow(
      'NICHT_ANGEHAENGT',
    );
    expect(h.nichtAngehaengt).toHaveBeenCalledWith(fehler, 'nachweisAnhaengen');
  });

  it('Entfernen: Nachweis-ID geprüft, danach Freigabe über den Baustein', async () => {
    await aktionen.nachweisEntfernenAction(MANDANT, DID, null, formular([['nachweisId', '../x']]));
    expect(spec().parse!().ok).toBe(false);
    await aktionen.nachweisEntfernenAction(
      MANDANT,
      DID,
      null,
      formular([['nachweisId', 'cmvf9s01r0000lh7dmncuj80d']]),
    );
    const s = spec();
    const ctx = await s.vorbereiten!({}, K, await geparst());
    const d = dienst();
    await expect(s.aufruf(d, await geparst(), ctx)).resolves.toEqual({
      meldung: 'Nachweis entfernt.',
    });
    expect(h.entfernen).toHaveBeenCalledWith(d, CTX, {
      mandantId: MANDANT,
      durchfuehrungId: DID,
      nachweisId: 'cmvf9s01r0000lh7dmncuj80d',
    });
  });
});
