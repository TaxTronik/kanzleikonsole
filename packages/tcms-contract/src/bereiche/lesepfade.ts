// =============================================================================
// Vertrag (zod) des Bereichs „lesepfade" (Welle 2): Eingaben und Antworten.
//
// Antworten sind streng (`.strict()`): Der Dienst prüft seine eigene Antwort
// vor dem Senden gegen diese Schemas, damit kein Feld ungeplant nach außen
// gelangt (fail closed). Zeitpunkte als ISO-8601 (UTC), Kalendertage als
// `YYYY-MM-DD`, Personen nur als IDs der kanzleikonsole (ADR 0001 §5, §7).
// =============================================================================

import { z } from 'zod';
import { MAX_MANDANTEN_JE_ANFRAGE } from '../fehler';

/**
 * Stichtag `YYYY-MM-DD` (nur gültige Kalendertage). Gemeinsam für alle Leser
 * mit `?stand=` (ADR 0001 §7); schreibende Operationen nehmen keinen Stichtag
 * an (TS-07).
 */
export const StandSchema = z.iso.date();

/**
 * Tax-CMS-Kontext eines Mandanten lesen. Ohne `stand` gilt „heute" der Uhr;
 * ein Stand ab heute ist der aktuelle Stand (nicht historisch).
 */
export const KontextEingabeSchema = z
  .object({
    mandantId: z.uuid(),
    stand: StandSchema.optional(),
  })
  .strict();

export type KontextEingabe = z.infer<typeof KontextEingabeSchema>;

/** Query von `GET /v1/mandanten/:mandantId/kontext`. */
export const KontextQuerySchema = z.object({ stand: StandSchema.optional() }).strict();

// ---------------------------------------------------------------------------
// Bausteine der Antworten (modulintern, damit Namen anderer Bereiche frei bleiben)
// ---------------------------------------------------------------------------

const zeitpunkt = z.iso.datetime();
const objektId = z.string().min(1).max(200);
/** Personen-ID der kanzleikonsole (Mitarbeiter oder Mandantenkontakt). */
const personId = z.string().min(1).max(200);
const text = (max: number) => z.string().max(max);
const klasse = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']);
const governanceTyp = z.enum(['FP', 'FF', 'IN']);
const turnus = z.enum(['KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH']);
const frequenz = z.object({ turnus, anlass: z.boolean() }).strict();
const anzeigeStatus = z.enum([
  'GEPLANT',
  'FAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZUR_GEGENZEICHNUNG',
  'ZURUECKGEWIESEN',
  'OHNE_BEFUND',
  'MIT_BEFUND',
  'UEBERFAELLIG',
  'ENTFALLEN',
]);
const design = z.enum(['ANGEMESSEN', 'NICHT_BEURTEILT', 'MANGEL']);
const betriebsStand = z.enum(['OK', 'MIT_BEFUND', 'UEBERFAELLIG', 'KEINE']);
const partei = z.enum(['KANZLEI', 'MANDANT']);
const mandantRolle = z.enum([
  'GESETZLICHER_VERTRETER',
  'TAX_COMPLIANCE_BEAUFTRAGTER',
  'MITARBEITER',
]);
const grundelementKey = z.enum([
  'kultur',
  'ziele',
  'risiken',
  'programm',
  'organisation',
  'kommunikation',
  'ueberwachung',
]);
const bausteinArt = z.enum([
  'TEILBEREICH',
  'ZIELE',
  'RISIKOINVENTAR',
  'KONTROLLMATRIX',
  'VERANTWORTUNG',
  'LAENDER',
  'FESTSTELLUNGEN',
]);
const abschnitt = z
  .object({
    key: z.enum([
      'teilbereich',
      'kultur',
      'ziele',
      'risiken',
      'programm',
      'organisation',
      'kommunikation',
      'ueberwachung',
      'anhang',
    ]),
    bloecke: z.array(
      z.discriminatedUnion('typ', [
        z.object({ typ: z.literal('text'), text: text(100_000) }).strict(),
        z.object({ typ: z.literal('baustein'), art: bausteinArt }).strict(),
      ]),
    ),
  })
  .strict();
const nettoErgebnis = z
  .object({
    klasse,
    abschlag: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    erklaerung: text(2000),
    zaehlend: z.array(text(50)),
  })
  .strict();
const risikoBewertung = z
  .object({
    brutto: z
      .object({
        klasse,
        punkte: z.number(),
        basis: klasse,
        angehoben: z.boolean(),
        erklaerung: text(2000),
      })
      .strict(),
    nettoDesign: nettoErgebnis,
    nettoBetrieb: nettoErgebnis,
    wirksamDesign: klasse,
    wirksamBetrieb: klasse,
    uebersteuertDesign: z.boolean(),
    uebersteuertBetrieb: z.boolean(),
    modell: text(500),
  })
  .strict();
const frequenzAbleitung = z
  .object({
    mindest: frequenz,
    effektiv: frequenz,
    gt: governanceTyp.nullable(),
    quelle: z
      .object({ code: text(50), gt: governanceTyp, brutto: klasse })
      .strict()
      .nullable(),
    abweichendVonVorlage: z.boolean(),
    begruendung: text(2000),
  })
  .strict();

const durchfuehrungSicht = z
  .object({
    id: objektId,
    kontrolleId: objektId,
    code: text(50),
    titel: text(500),
    periodeLabel: text(100),
    periodeVon: zeitpunkt,
    periodeBis: zeitpunkt,
    faelligAm: zeitpunkt,
    status: text(50),
    anzeige: anzeigeStatus,
    ausserplanmaessig: z.boolean(),
    anlass: text(2000).nullable(),
    partei,
    durchfuehrendId: personId.nullable(),
    gegenzeichnerId: personId.nullable(),
    durchgefuehrtVon: personId.nullable(),
    gegengezeichnetVon: personId.nullable(),
    mandantBestaetigtVon: personId.nullable(),
    eingereichtAm: zeitpunkt.nullable(),
    abgeschlossenAm: zeitpunkt.nullable(),
    nachweise: z.number().int(),
    mindestNachweise: z.number().int(),
    gt: governanceTyp.nullable(),
    schluessel: z.boolean(),
  })
  .strict();

const risikoSicht = z
  .object({
    id: objektId,
    code: text(50),
    gruppe: z.enum(['UST', 'GOB', 'ERT', 'VER']),
    gruppeLabel: text(100),
    kern: z.boolean(),
    herkunft: z.enum(['KATALOG', 'BERATER']),
    freigabe: z.enum(['IDENTIFIZIERT', 'BEWERTET', 'ZUR_FREIGABE', 'FREIGEGEBEN']),
    freigabeEingereichtVon: personId.nullable(),
    freigegebenVon: personId.nullable(),
    freigegebenAm: zeitpunkt.nullable(),
    ownerId: personId.nullable(),
    neuBewerten: z.boolean(),
    vorschlagsgrund: text(2000).nullable(),
    standId: objektId,
    titel: text(500),
    fehlerquelle: text(10_000),
    folge: text(10_000),
    normanker: z.array(
      z
        .object({ text: text(500), stufe: z.enum(['GEPRUEFT', 'UNGEPRUEFT', 'KI_VERMUTUNG']) })
        .strict(),
    ),
    s: z.enum(['N', 'M', 'H']),
    w: z.enum(['SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG']),
    r: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    gt: governanceTyp,
    gueltigAb: zeitpunkt,
    kontrollIds: z.array(objektId),
    bewertung: risikoBewertung,
    netto: klasse,
    ueberAppetit: z.boolean(),
    uebersteuerungen: z.array(
      z
        .object({
          id: objektId,
          sicht: z.enum(['DESIGN', 'BETRIEB']),
          klasse,
          berechnet: klasse,
          begruendung: text(10_000),
          status: z.enum(['BEANTRAGT', 'FREIGEGEBEN', 'ABGELEHNT', 'AUFGEHOBEN']),
          beantragtVon: personId,
          beantragtAm: zeitpunkt,
          entschiedenVon: personId.nullable(),
          entschiedenAm: zeitpunkt.nullable(),
        })
        .strict(),
    ),
    offeneEreignisse: z.number().int(),
    wirktAuf: z.array(text(100)),
  })
  .strict();

/**
 * Fehlende Pflichtattribute einer Kontrolle (Fachkonzept §6), feste Texte in
 * fester Reihenfolge. `pflichtattributeOk` ist genau dann `true`, wenn die
 * Liste leer ist (eine Regel im Dienst, beide Felder daraus). Die
 * Designbeurteilung ist kein Pflichtattribut (eigenes Feld `design`).
 */
export const PFLICHTATTRIBUT_LUECKEN = [
  'Ziel',
  'Schritte',
  'Nachweisanforderung',
  'durchführende Person',
  'Vertretung (verschieden von der durchführenden Person)',
  'Gegenzeichnung (Pflicht bei Schlüsselkontrollen)',
] as const;
export const PflichtattributLueckeSchema = z.enum(PFLICHTATTRIBUT_LUECKEN);
export type PflichtattributLuecke = z.infer<typeof PflichtattributLueckeSchema>;

const kontrolleSicht = z
  .object({
    id: objektId,
    code: text(50),
    standId: objektId,
    version: z.number().int(),
    titel: text(500),
    ziel: text(10_000),
    art: z.enum(['P', 'D', 'K']),
    ausfuehrung: z.enum(['M', 'IT', 'A']),
    vorlage: frequenz,
    abweichung: z
      .object({
        frequenz,
        begruendung: text(10_000).nullable(),
        freigegebenVon: personId.nullable(),
      })
      .strict()
      .nullable(),
    partei,
    schluessel: z.boolean(),
    durchfuehrendId: personId.nullable(),
    vertretungId: personId.nullable(),
    gegenzeichnerId: personId.nullable(),
    gegenzeichnungMandant: z.boolean(),
    nachweis: text(10_000),
    mindestNachweise: z.number().int(),
    schritte: z.array(z.object({ titel: text(500), hinweis: text(5000) }).strict()),
    kennzahlen: z.array(
      z
        .object({
          key: text(100),
          label: text(500),
          sollEur: z.number().nullable(),
          differenzAus: z.tuple([text(100), text(100)]).optional(),
        })
        .strict(),
    ),
    toleranzEur: z.number().nullable(),
    faelligNachTagen: z.number().int(),
    design,
    designVon: personId.nullable(),
    designAm: zeitpunkt.nullable(),
    designBegruendung: text(10_000).nullable(),
    risikoIds: z.array(objektId),
    risikoCodes: z.array(text(50)),
    ableitung: frequenzAbleitung,
    frequenz,
    gt: governanceTyp.nullable(),
    betrieb: betriebsStand,
    letzte: durchfuehrungSicht.nullable(),
    naechste: durchfuehrungSicht.nullable(),
    pflichtattributeOk: z.boolean(),
    /** Fehlende Pflichtattribute; leer genau bei `pflichtattributeOk`. */
    pflichtattributeLuecken: z.array(PflichtattributLueckeSchema),
  })
  .strict();

const feststellungStatus = z.enum([
  'ERFASST',
  'IN_WUERDIGUNG',
  'MASSNAHMEN_OFFEN',
  'NACHKONTROLLE',
  'GESCHLOSSEN',
  'VERWORFEN',
]);

/** Feststellung, die der Akteur lesen darf (nicht vertraulich oder beteiligt). */
const feststellungLesbar = z
  .object({
    maskiert: z.literal(false),
    id: objektId,
    nummer: text(50),
    titel: text(500),
    sachverhalt: text(20_000),
    quelle: z.enum(['KONTROLLE', 'EREIGNIS', 'STICHPROBE', 'HINWEIS', 'AUSSENPRUEFUNG']),
    quelleText: text(2000),
    klasse: z.enum(['DESIGNMANGEL', 'DURCHFUEHRUNGSMANGEL', 'STEUERLICHER_FEHLER', 'HINWEIS']),
    schwere: klasse,
    auswirkung: z.enum(['JA', 'NEIN', 'UNKLAR']),
    status: feststellungStatus,
    vertraulich: z.boolean(),
    beteiligte: z.array(personId),
    p153Entscheidung: z
      .enum(['BERICHTIGUNG', 'KEINE_PFLICHT', 'WEITERE_KLAERUNG', 'UEBERGABE'])
      .nullable(),
    p153Offen: z.boolean(),
    massnahmenOffen: z.number().int(),
    massnahmen: z.number().int(),
    aeltesteFrist: zeitpunkt.nullable(),
    erfasstAm: zeitpunkt,
    risikoCodes: z.array(text(50)),
  })
  .strict();

/**
 * Vertrauliche Feststellung für Nicht-Beteiligte (Fachkonzept §13, RT-01):
 * dieselbe Information wie der Lesepfad `GET …/feststellungen` mit
 * `maskiert: true` – Nummer, Status, Erfassung; keine Steuerwirkung, keine
 * §-153-Angaben, keine Schwere, Klasse, Maßnahmen oder Beteiligten.
 */
const feststellungMaskiert = z
  .object({
    maskiert: z.literal(true),
    id: objektId,
    nummer: text(50),
    vertraulich: z.literal(true),
    status: feststellungStatus,
    erfasstAm: zeitpunkt,
  })
  .strict();

const feststellungSicht = z.discriminatedUnion('maskiert', [
  feststellungLesbar,
  feststellungMaskiert,
]);

const ereignisSicht = z
  .object({
    id: objektId,
    nummer: text(50),
    typ: text(100),
    titel: text(500),
    beschreibung: text(20_000),
    quelle: z.enum(['PORTAL', 'KONTROLLE', 'STAMMDATEN', 'RSS', 'MANUELL']),
    gemeldetVon: personId.nullable(),
    gemeldetAm: zeitpunkt,
    ereignisDatum: zeitpunkt,
    status: z.enum(['NEU', 'IN_TRIAGE', 'ERLEDIGT', 'VERWORFEN']),
    verwerfenBegruendung: text(10_000).nullable(),
    triagiertVon: personId.nullable(),
    triagiertAm: zeitpunkt.nullable(),
    folgen: z.array(
      z
        .object({
          id: objektId,
          art: text(100),
          ziel: text(200).nullable(),
          text: text(10_000),
          zustaendig: personId.nullable(),
          frist: zeitpunkt.nullable(),
          status: z.enum(['VORGESCHLAGEN', 'ANGELEGT', 'ERLEDIGT', 'VERWORFEN']),
          objektId: objektId.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const landSicht = z
  .object({
    id: objektId,
    land: text(10),
    fernverkaeufeLfdEur: z.number(),
    fernverkaeufeVorjahrEur: z.number(),
    lagerSeit: text(20).nullable(),
    oss: z.boolean(),
    lokaleUstNr: z.boolean(),
    zmRelevant: z.boolean(),
    steuersaetzeGeprueftAm: zeitpunkt.nullable(),
    stand: zeitpunkt,
    quelle: z.enum(['MANUELL', 'CSV']),
    erfasstVon: personId.nullable(),
    registrierung: z.enum(['VOLLSTAENDIG', 'FEHLT', 'PRUEFEN']),
  })
  .strict();

const beschreibungSicht = z
  .object({
    id: objektId,
    nummer: text(50),
    status: z.enum(['ENTWURF', 'KANZLEI_REVIEW', 'BEIM_MANDANTEN', 'FREIGEGEBEN', 'ABGELOEST']),
    abschnitte: z.array(abschnitt),
    createdAt: zeitpunkt,
    erstelltVon: personId.nullable(),
    reviewAngefordertVon: personId.nullable(),
    reviewAngefordertAm: zeitpunkt.nullable(),
    reviewVon: personId.nullable(),
    reviewAm: zeitpunkt.nullable(),
    freigabeAngefordertAm: zeitpunkt.nullable(),
    freigegebenVon: personId.nullable(),
    freigegebenAm: zeitpunkt.nullable(),
    snapshotSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict();

const prueflastSicht = z
  .object({
    monat: z.string().regex(/^\d{4}-\d{2}$/),
    FP: z.number().int(),
    FF: z.number().int(),
    IN: z.number().int(),
    ausloesungen: z.number().int(),
    gesamt: z.number().int(),
  })
  .strict();

/**
 * Stammdaten des Mandanten pflegen – Anker (`PUT /v1/mandanten/:mandantId`) und
 * Kontaktrollen (`PUT …/kontakte`) – als Kennzeichen für die Oberfläche. Der
 * Dienst berechnet es mit derselben Regel wie diese Schreiboperationen
 * (`kannBearbeiten`: Admin/Partner, zuständige:r BT oder Hauptbearbeitung);
 * ein falsches `true` öffnet nichts, der Dienst prüft beim Schreiben erneut.
 */
const stammdatenRechte = z
  .object({
    bearbeiten: z.boolean(),
  })
  .strict();

/**
 * Kennzeichen „bearbeiten" der Lese-Antworten eines Bereichs (Risikoinventar,
 * Kontrollmatrix, Länder-Monitor): Der Dienst rechnet es mit derselben
 * Rechtefunktion wie die Schreiboperationen dieses Bereichs (`kannBearbeiten`);
 * im historischen Stand und ohne Programm `false`. Ein falsches `true` öffnet
 * nichts: Jede Schreiboperation prüft erneut.
 */
export const BearbeitenRechteSchema = z
  .object({
    bearbeiten: z.boolean(),
  })
  .strict();
export type BearbeitenRechte = z.infer<typeof BearbeitenRechteSchema>;

/** Rechte des Akteurs für diesen Mandanten als Kennzeichen für die Oberfläche (ADR 0001 §5). */
const kontextRechte = z
  .object({
    /** Bearbeiten (aktueller Stand und `kannBearbeiten`). */
    bearbeiten: z.boolean(),
    /** §-153-Würdigung (aktueller Stand und `kannWuerdigen`). */
    wuerdigen: z.boolean(),
  })
  .strict();

/** Antwort von `GET /v1/mandanten/:mandantId/kontext`. */
export const KontextAntwortSchema = z
  .object({
    heute: StandSchema,
    stand: StandSchema,
    historisch: z.boolean(),
    mandant: z
      .object({
        id: z.uuid(),
        name: text(200),
        rechtsform: text(50),
        datevNr: text(20).nullable(),
        /** Anker pflegen; im historischen Stand `false` (AGENTS.md Regel 6). */
        rechte: stammdatenRechte,
      })
      .strict(),
    rechte: kontextRechte,
    kontaktRollen: z.array(
      z
        .object({ kontaktId: personId, rolle: mandantRolle, funktion: text(200).nullable() })
        .strict(),
    ),
    programm: z
      .object({
        id: objektId,
        status: z.enum(['ENTWURF', 'AKTIV']),
        paketVersion: text(50),
        erklaerungsTurnus: turnus,
        angemessenheitStichtag: zeitpunkt.nullable(),
        wirksamAb: zeitpunkt.nullable(),
        wirksamBis: zeitpunkt.nullable(),
        version1Am: zeitpunkt.nullable(),
        createdAt: zeitpunkt,
      })
      .strict()
      .nullable(),
    teilbereich: z
      .object({
        id: objektId,
        name: text(500),
        abgrenzung: text(20_000),
        einschluesse: z.array(text(2000)),
        ausschluesse: z.array(text(2000)),
      })
      .strict()
      .nullable(),
    ziele: z.array(
      z
        .object({
          id: objektId,
          text: text(10_000),
          wesentlichkeitEur: z.number(),
          risikoappetit: klasse,
          freigabe: z.enum(['ENTWURF', 'AUSSTEHEND', 'FREIGEGEBEN']),
          freigegebenAm: zeitpunkt.nullable(),
          freigegebenVon: personId.nullable(),
        })
        .strict(),
    ),
    appetit: klasse,
    /** Geschäftsprofil (beim Speichern geprüft, hier unverändert). */
    profil: z.record(z.string(), z.json()).nullable(),
    profilGueltigAb: zeitpunkt.nullable(),
    risiken: z.array(risikoSicht),
    vorschlaege: z.array(
      z
        .object({
          id: objektId,
          code: text(50),
          grund: text(2000).nullable(),
          entscheidung: z.enum(['VORGESCHLAGEN', 'ABGELEHNT']),
          ablehnungsgrund: text(10_000).nullable(),
        })
        .strict(),
    ),
    kontrollen: z.array(kontrolleSicht),
    durchfuehrungen: z.array(durchfuehrungSicht),
    feststellungen: z.array(feststellungSicht),
    ereignisse: z.array(ereignisSicht),
    laender: z.array(landSicht),
    schwelle: z
      .object({
        status: z.enum(['UNTERSCHRITTEN', 'WARNUNG', 'UEBERSCHRITTEN']),
        anteilLfd: z.number(),
        anteilVorjahr: z.number(),
        label: text(200),
      })
      .strict(),
    fernverkaeufeLfd: z.number(),
    fernverkaeufeVorjahr: z.number(),
    laenderStand: zeitpunkt.nullable(),
    laenderQuelle: z.enum(['MANUELL', 'CSV']).nullable(),
    beschreibungen: z.array(beschreibungSicht),
    phasen: z.array(
      z
        .object({
          nr: z.number().int(),
          name: text(200),
          bedingungen: z.array(
            z
              .object({ text: text(500), erfuellt: z.boolean(), link: text(100).optional() })
              .strict(),
          ),
          erfuellt: z.boolean(),
        })
        .strict(),
    ),
    aktivePhase: z.number().int(),
    grundelemente: z.array(
      z
        .object({
          key: grundelementKey,
          titel: text(200),
          icon: text(100),
          luecken: z.array(text(500)),
        })
        .strict(),
    ),
    prueflast: z.array(prueflastSicht),
    zeitraum: z
      .object({
        monat: z.number().int(),
        monate: z.number().int(),
        relevante: z.number().int(),
        ohneBefund: z.number().int(),
        mitBefund: z.number().int(),
        offen: z.number().int(),
        ohneGegenzeichnung: z.number().int(),
        ueberfaellig: z.number().int(),
        fehlendeNachweise: z.number().int(),
        /**
         * Codes wiederkehrender Kontrollen (Turnus ≠ KEIN) ohne jede – auch
         * geplante – nicht entfallene Durchführung mit Fälligkeit im
         * Wirksamkeitszeitraum (+ 60 Tage Nachlauf); leer, solange der
         * Zeitraum zum Stand nicht begonnen hat (Oberfläche: „n. a.").
         */
        ohneDurchfuehrung: z.array(text(50)),
        /** Summe der Nachweise abgeschlossener Durchführungen (ohne/mit Befund) im Zeitraum. */
        nachweise: z.number().int(),
        /** Entfallene Durchführungen im Zeitraum (zählen nicht als „ohne Befund"). */
        entfallen: z.number().int(),
      })
      .strict()
      .nullable(),
    ausgeblendet: z.number().int(),
  })
  .strict();

export type KontextAntwort = z.infer<typeof KontextAntwortSchema>;

// ---------------------------------------------------------------------------
// Mandantenübergreifende Lesepfade: Portfolio und Arbeitskorb (ADR 0001 §3.3)
// ---------------------------------------------------------------------------

const uuidListe = z.array(z.uuid()).max(MAX_MANDANTEN_JE_ANFRAGE);

/**
 * Zugängliche Mandanten der Person, von der kanzleikonsole bestätigt (Body,
 * gebunden über `req.b`). `bt`/`hb`: Teilmengen, in denen die Person
 * zuständige:r Berufsträger:in bzw. Hauptbearbeitung ist – wie `cli.bt`/
 * `cli.hb` je Mandant. Doppelte oder fremde Einträge machen die Anfrage
 * ungültig (keine mehrdeutigen Rechte). Höchstens `MAX_MANDANTEN_JE_ANFRAGE`
 * IDs; 5 000 IDs passen in die Body-Grenze von 256 KiB.
 */
export const MandantenListeSchema = z
  .object({
    mandantIds: uuidListe,
    bt: uuidListe.default([]),
    hb: uuidListe.default([]),
  })
  .strict()
  .superRefine((e, ctx) => {
    const alle = new Set<string>();
    for (const [i, id] of e.mandantIds.entries()) {
      const k = id.toLowerCase();
      if (alle.has(k))
        ctx.addIssue({ code: 'custom', path: ['mandantIds', i], message: 'doppelt' });
      alle.add(k);
    }
    for (const feld of ['bt', 'hb'] as const) {
      const gesehen = new Set<string>();
      for (const [i, id] of e[feld].entries()) {
        const k = id.toLowerCase();
        if (!alle.has(k) || gesehen.has(k)) {
          ctx.addIssue({
            code: 'custom',
            path: [feld, i],
            message: 'nicht in mandantIds oder doppelt',
          });
        }
        gesehen.add(k);
      }
    }
  });

export type MandantenListe = z.input<typeof MandantenListeSchema>;

const mandantKurz = z.object({ id: z.uuid(), name: text(200) }).strict();
const programmZeitraum = z.discriminatedUnion('art', [
  z
    .object({
      art: z.literal('LAUFEND'),
      monat: z.number().int(),
      monate: z.number().int(),
      ab: zeitpunkt,
      bis: zeitpunkt,
    })
    .strict(),
  z.object({ art: z.literal('BEVORSTEHEND'), ab: zeitpunkt, bis: zeitpunkt }).strict(),
  z.object({ art: z.literal('ABGESCHLOSSEN'), ab: zeitpunkt, bis: zeitpunkt }).strict(),
  z.object({ art: z.literal('OFFEN') }).strict(),
]);

/** Antwort von `POST /v1/portfolio`: Kennzahlen je Mandant, keine Personenvergleiche. */
export const PortfolioAntwortSchema = z
  .object({
    heute: StandSchema,
    zeilen: z.array(
      z
        .object({
          mandant: z.object({ id: z.uuid(), name: text(200), rechtsform: text(50) }).strict(),
          /** Bearbeitungsrecht (z. B. Einrichtung starten), aus `rol.adm` bzw. `bt`/`hb`. */
          darfBearbeiten: z.boolean(),
          hatProgramm: z.boolean(),
          entwurf: z.boolean(),
          paket: text(200).nullable(),
          teilbereich: text(500).nullable(),
          phase: z.number().int(),
          phaseName: text(200),
          risiken: z.number().int(),
          ueberAppetit: z.number().int(),
          appetit: klasse.nullable(),
          prueflast: prueflastSicht.nullable(),
          faellig: z.number().int(),
          ueberfaellig: z.number().int(),
          zurGegenzeichnung: z.number().int(),
          feststellungenOffen: z.number().int(),
          feststellungenHochOffen: z.number().int(),
          p153Offen: z.number().int(),
          ereignisseNeu: z.number().int(),
          zeitraum: programmZeitraum,
          naechsterTermin: z
            .object({
              datum: zeitpunkt,
              code: text(50),
              titel: text(500),
              periode: text(100),
              durchfuehrungId: objektId,
              anzeige: anzeigeStatus,
            })
            .strict()
            .nullable(),
          handlungsbedarf: z.boolean(),
          /** Sortierschlüssel: höher = dringender. */
          prioritaet: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict();

export type PortfolioAntwort = z.infer<typeof PortfolioAntwortSchema>;

const akDurchfuehrung = {
  mandant: mandantKurz,
  id: objektId,
  code: text(50),
  titel: text(500),
  periode: text(100),
  faelligAm: zeitpunkt,
  tage: z.number().int(),
  anzeige: anzeigeStatus,
  schluessel: z.boolean(),
  nachweise: z.number().int(),
  mindestNachweise: z.number().int(),
};

/**
 * Antwort von `POST /v1/arbeitskorb`: eigene Aufgaben der Person über die
 * zugänglichen Mandanten. Personen nur als IDs.
 */
export const ArbeitskorbAntwortSchema = z
  .object({
    heute: StandSchema,
    durchfuehrungen: z.array(z.object(akDurchfuehrung).strict()),
    gegenzeichnungen: z.array(
      z
        .object({
          ...akDurchfuehrung,
          durchgefuehrtVon: personId.nullable(),
          eingereichtAm: zeitpunkt.nullable(),
        })
        .strict(),
    ),
    vierAugen: z.array(
      z
        .object({
          mandant: mandantKurz,
          art: z.enum(['UEBERSTEUERUNG', 'FREQUENZ', 'VERWERFEN', 'RISIKOFREIGABE']),
          key: text(200),
          /** Objekt, auf das sich die Bestätigung bezieht (Risiko, Kontrolle, Feststellung). */
          objektId: objektId.nullable(),
          titel: text(1000),
          detail: text(1000),
          begruendung: text(10_000).nullable(),
          beantragtVon: z.array(personId),
          beantragtAm: zeitpunkt.nullable(),
        })
        .strict(),
    ),
    p153: z.array(
      z
        .object({
          mandant: mandantKurz,
          id: objektId,
          nummer: text(50),
          titel: text(500),
          schwere: klasse,
          auswirkung: z.enum(['JA', 'NEIN', 'UNKLAR']),
          vertraulich: z.boolean(),
          erfasstAm: zeitpunkt,
        })
        .strict(),
    ),
    /** Ohne Würdigungsrecht: offene Würdigungen in Mandaten, für die die Person zuständig ist. */
    p153BeiAnderen: z.object({ anzahl: z.number().int(), mandantIds: z.array(z.uuid()) }).strict(),
    ereignisse: z.array(
      z
        .object({
          mandant: mandantKurz,
          id: objektId,
          nummer: text(50),
          typ: text(100),
          titel: text(500),
          quelle: z.enum(['PORTAL', 'KONTROLLE', 'STAMMDATEN', 'RSS', 'MANUELL']),
          gemeldetVon: personId.nullable(),
          gemeldetAm: zeitpunkt,
        })
        .strict(),
    ),
    beschreibungen: z.array(
      z
        .object({
          mandant: mandantKurz,
          id: objektId,
          nummer: text(50),
          angefordertVon: personId.nullable(),
          angefordertAm: zeitpunkt.nullable(),
        })
        .strict(),
    ),
    mandantenZustaendig: z.number().int(),
  })
  .strict();

export type ArbeitskorbAntwort = z.infer<typeof ArbeitskorbAntwortSchema>;

// ---------------------------------------------------------------------------
// Portal-Startseite (P1, `portal: true`)
// ---------------------------------------------------------------------------

/** Eingabe der Portal-Übersicht: nur der eigene Mandant (Pfad, gebunden an `cli.id`). */
export const PortalUebersichtEingabeSchema = z.object({ mandantId: z.uuid() }).strict();
export type PortalUebersichtEingabe = z.infer<typeof PortalUebersichtEingabeSchema>;

/**
 * Antwort von `GET /v1/mandanten/:mandantId/portal/uebersicht`: mandantenbezogene
 * Sicht ohne Kanzlei-Interna (keine Nettoklassen, keine Feststellungen, keine
 * §-153-Details). Gesetzliche Vertretung und Tax-Compliance-Beauftragte sehen
 * alle Mandantenaufgaben, Mitarbeitende nur ihre eigenen.
 */
export const PortalUebersichtAntwortSchema = z
  .object({
    heute: StandSchema,
    mandant: mandantKurz,
    rechte: z
      .object({
        /** Übersicht über alle Mandantenaufgaben (GV, TCB). */
        portalLesen: z.boolean(),
        gesetzlicherVertreter: z.boolean(),
        /** Ereignisse melden (GV, TCB). */
        melden: z.boolean(),
      })
      .strict(),
    programm: z
      .object({
        aktivePhase: z.number().int(),
        wirksamAb: zeitpunkt.nullable(),
        wirksamBis: zeitpunkt.nullable(),
        zeitraum: z
          .object({ monat: z.number().int(), monate: z.number().int() })
          .strict()
          .nullable(),
        monate: z.array(
          z
            .object({
              label: text(20),
              zustand: z.enum(['done', 'now', 'offen', '']),
              offen: z.number().int(),
            })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    aufgaben: z.array(
      z
        .object({
          art: z.enum(['DURCHFUEHREN', 'BESTAETIGEN']),
          /** Der Person selbst zugewiesen (durchführend, Vertretung bzw. bestätigend). */
          eigene: z.boolean(),
          durchfuehrungId: objektId,
          code: text(50),
          titel: text(500),
          periodeLabel: text(100),
          faelligAm: zeitpunkt,
          anzeige: anzeigeStatus,
          status: text(50),
          nachweise: z.number().int(),
          mindestNachweise: z.number().int(),
          zustaendigId: personId.nullable(),
          nachweis: text(10_000),
          ziel: text(10_000),
        })
        .strict(),
    ),
    meldungen: z.array(
      z
        .object({
          id: objektId,
          nummer: text(50),
          typ: text(100),
          titel: text(500),
          status: z.enum(['NEU', 'IN_TRIAGE', 'ERLEDIGT', 'VERWORFEN']),
          gemeldetAm: zeitpunkt,
          gemeldetVon: personId.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type PortalUebersichtAntwort = z.infer<typeof PortalUebersichtAntwortSchema>;

// ---------------------------------------------------------------------------
// Mandantenanker und Kontaktrollen (ADR 0001 §5): Pflege durch die kanzleikonsole
// ---------------------------------------------------------------------------

/**
 * Zeichenregel: Zeichen, die in einzeiligen Texten (Stammdaten, Titel, Namen)
 * und Dateinamen nie vorkommen dürfen – eine Regel für den ganzen Vertrag,
 * den Dienst (`einzeilig`, Dateinamen von Anlagen und Nachweisen,
 * `pruefeVerweis`) und den statischen Repo-Test (`repo-zeichen.test.ts`, dort
 * ohne TAB und LF). Sie folgt aus Unicode-Eigenschaften statt aus einer Liste
 * (RT4-T-01): Eine Liste übersah standardmäßig unsichtbare Zeichen wie die
 * Variantenselektoren U+FE00–U+FE0F und U+E0100–U+E01EF, mit denen sich
 * beliebige Bytes in einem sichtbaren Text verstecken lassen.
 *
 *   Cc   Steuerzeichen: C0 U+0000–U+001F (auch TAB, LF, CR), DEL, C1
 *   Cf   Formatzeichen: Richtung (LRM, RLM, ALM, Einbettung, Überschreibung,
 *        Isolierung), Nullbreite (ZWSP, ZWNJ, ZWJ, Wortverbinder, BOM),
 *        weiches Trennzeichen, Tag-Zeichen U+E0001–U+E007F u. a.
 *   Zl   Zeilentrenner U+2028; Zp Absatztrenner U+2029
 *   Default_Ignorable_Code_Point
 *        alles standardmäßig Unsichtbare, auch ohne Formatkategorie: Füller
 *        (U+115F, U+1160, U+3164, U+FFA0), Variantenselektoren, U+034F,
 *        U+17B4/U+17B5, U+180B–U+180F, reservierte Bereiche (U+2065,
 *        U+FFF0–U+FFF8, U+E0000–U+E0FFF)
 *   Cs   einzelne Surrogate (kein gültiger Text; PostgreSQL speichert sie nicht)
 *
 * Der Umfang folgt der Unicode-Version der Laufzeit (Node 24: Unicode 17);
 * Vertrag und kanzleikonsole laufen auf derselben Node-Version. Der Ausdruck
 * arbeitet auf Code Points (`u`) und steht ohne rohe Zeichen im Quelltext.
 */
export const UNZULAESSIG_KLASSE = String.raw`\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Cs}`;
export const UNZULAESSIGE_ZEICHEN = new RegExp(`[${UNZULAESSIG_KLASSE}]`, 'u');

/**
 * Basisregel jedes Texts einer Eingabe (RT4-T-08): kein NUL und keine
 * einzelnen Surrogate. PostgreSQL speichert beides nicht (TEXT kein NUL,
 * JSONB weder `\u0000` noch ein einzelnes Surrogat); ohne die Regel endete
 * eine vertragsgültige Eingabe als `500 INTERN`. Gilt für jeden Freitext
 * (`mitTextBasis`, `freitext`; Zeilenumbruch und TAB bleiben erlaubt);
 * einzeilige Texte und Dateinamen prüfen die strengere Zeichenregel, die
 * beides einschließt. `__tests__/eingabetexte.test.ts` prüft jedes
 * Zeichenkettenfeld des Endpunktregisters.
 */
export const TEXT_UNZULAESSIG = /[\u0000\p{Cs}]/u;
export const TEXT_UNZULAESSIG_MELDUNG = 'Unzulässige Zeichen (NUL oder einzelnes Surrogat)';

/** Hängt die Basisregel an eine Zeichenkette der Eingabe an. */
export function mitTextBasis(s: z.ZodString): z.ZodString {
  return s.refine((t) => !TEXT_UNZULAESSIG.test(t), TEXT_UNZULAESSIG_MELDUNG);
}

// NUL und andere Steuerzeichen (außer Tab/Zeilenumbruch) sind in Freitexten nie fachlich.
const STEUERZEICHEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Freitext (mehrzeilig): getrimmt, Längengrenzen, ohne Steuerzeichen, mit Basisregel. */
export function freitext(min: number, max: number) {
  return mitTextBasis(
    z
      .string()
      .trim()
      .min(min)
      .max(max)
      .refine((s) => !STEUERZEICHEN.test(s), 'Steuerzeichen sind nicht erlaubt'),
  );
}

/** Dateiname: dieselben Zeichen und zusätzlich keine Pfadtrenner (`/`, Backslash). */
export const DATEINAME_UNZULAESSIG = new RegExp(`[${UNZULAESSIG_KLASSE}/\\\\]`, 'u');

/**
 * Gespeicherte Dateinamen in Antworten (Ereignis-Anlagen aus dem Meldungs-Audit,
 * das hash-verkettet ist und nie umgeschrieben wird): nur die Zeichen, die schon
 * die frühere Eingaberegel abwies – C0, DEL, Pfadtrenner, Einbettung/
 * Überschreibung, Isolierung. Vor der Angleichung gespeicherte Namen (etwa mit
 * LRM oder Nullbreitenzeichen) bleiben so lesbar, wie eingefrorene Snapshots
 * (ADR 0001 §7); jede neue Eingabe prüft `DATEINAME_UNZULAESSIG`.
 */
export const DATEINAME_GESPEICHERT_UNZULAESSIG = new RegExp(
  String.raw`[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]`,
  'u',
);

/**
 * Einzeiliger Text einer Eingabe: getrimmt, Längengrenzen und die
 * Zeichenregel – also auch ohne CR, LF und TAB (Header-Injektion in Betreffs,
 * Anzeige-Spoofing). Gilt für die Stammdaten des Ankers und für alle Titel und
 * Namen (RT4-T-03), auch in den Vorlagendaten der Nachrichten
 * (`nachrichtTitel`) und den Namen eingefrorener Beschreibungen
 * (`namensEintrag`). Antworten mit gespeicherten Texten prüfen weiter nur die
 * Länge, damit Altbestände lesbar bleiben (wie `DATEINAME_GESPEICHERT_UNZULAESSIG`).
 */
export function einzeilig(min: number, max: number, meldungMin?: string) {
  return z
    .string()
    .trim()
    .min(min, meldungMin)
    .max(max)
    .refine((s) => !UNZULAESSIGE_ZEICHEN.test(s), 'Unzulässige Zeichen');
}

/** Body von `PUT /v1/mandanten/:mandantId`: Stammdaten des Mandantenankers. */
export const MandantAnkerBodySchema = z
  .object({
    name: einzeilig(1, 200),
    rechtsform: einzeilig(1, 50),
    datevNr: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .nullable()
      .default(null),
  })
  .strict();

export const MandantAnkerEingabeSchema = MandantAnkerBodySchema.extend({
  mandantId: z.uuid(),
}).strict();
export type MandantAnkerEingabe = z.input<typeof MandantAnkerEingabeSchema>;

export const MandantAnkerAntwortSchema = z
  .object({
    mandant: z
      .object({
        id: z.uuid(),
        name: text(200),
        rechtsform: text(50),
        datevNr: text(20).nullable(),
        aktiv: z.boolean(),
      })
      .strict(),
    /** true: neu angelegt; false: bestehender Anker (aktualisiert oder unverändert). */
    angelegt: z.boolean(),
    geaendert: z.boolean(),
  })
  .strict();
export type MandantAnkerAntwort = z.infer<typeof MandantAnkerAntwortSchema>;

/** Eingabe von `GET /v1/mandanten/:mandantId/kontakte`. */
export const KontakteEingabeSchema = z.object({ mandantId: z.uuid() }).strict();
export type KontakteEingabe = z.infer<typeof KontakteEingabeSchema>;

const kontaktRollenSicht = z
  .object({
    kontaktId: z.uuid(),
    rollen: z.array(
      z
        .object({ rolle: mandantRolle, aktiv: z.boolean(), funktion: text(200).nullable() })
        .strict(),
    ),
  })
  .strict();

export const KontakteAntwortSchema = z
  .object({
    kontakte: z.array(kontaktRollenSicht),
    /** Kontaktrollen setzen (`PUT …/kontakte`); nicht versioniert, ohne Stichtag. */
    rechte: stammdatenRechte,
  })
  .strict();
export type KontakteAntwort = z.infer<typeof KontakteAntwortSchema>;

/**
 * Body von `PUT /v1/mandanten/:mandantId/kontakte`: Die aktiven Rollen des
 * Kontakts beim Mandanten sind danach genau `rollen` (leer = Kontakt
 * deaktivieren); `funktion` gilt für die gesetzten Rollen.
 */
export const KontaktRollenBodySchema = z
  .object({
    kontaktId: z.uuid(),
    rollen: z
      .array(mandantRolle)
      .max(3)
      .refine((r) => new Set(r).size === r.length, 'Rolle doppelt'),
    funktion: einzeilig(1, 200).nullable().default(null),
  })
  .strict();

export const KontaktRollenEingabeSchema = KontaktRollenBodySchema.extend({
  mandantId: z.uuid(),
}).strict();
export type KontaktRollenEingabe = z.input<typeof KontaktRollenEingabeSchema>;

export const KontaktRollenAntwortSchema = kontaktRollenSicht
  .extend({ geaendert: z.boolean() })
  .strict();
export type KontaktRollenAntwort = z.infer<typeof KontaktRollenAntwortSchema>;

// ---------------------------------------------------------------------------
// Audit des Tenants (nur Admins/Partner der Kanzlei)
// ---------------------------------------------------------------------------

/** Höchstzahl Audit-Einträge je Seite. */
export const MAX_AUDIT_JE_SEITE = 500;

/**
 * Größte Position im Audit (Spalte `pos` ist INTEGER). `pos` zählt je Tenant
 * lückenlos ab 1 (RT-03); der globale technische Schlüssel verlässt den Dienst nie.
 */
export const MAX_AUDIT_POS = 2_147_483_647;

const posZahl = z.number().int().min(0).max(MAX_AUDIT_POS);
const zahlText = z
  .string()
  .regex(/^[0-9]{1,10}$/)
  .transform(Number)
  .pipe(posZahl);
const programmIdFilter = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const aktionPraefix = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9._]+$/);

/** Gemeinsame Regeln der Audit-Filter. */
function auditRegeln(
  e: { nach?: unknown; vor?: unknown; programmId?: unknown; mandantId?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (e.nach !== undefined && e.vor !== undefined)
    ctx.addIssue({ code: 'custom', path: ['vor'], message: 'nach und vor schließen sich aus' });
  if (e.programmId !== undefined && e.mandantId !== undefined)
    ctx.addIssue({
      code: 'custom',
      path: ['mandantId'],
      message: 'programmId und mandantId schließen sich aus',
    });
}

/** Eingabe von `ladeAudit` (Service): `nach` aufsteigend, `vor` absteigend (jeweils ohne). */
export const AuditListeEingabeSchema = z
  .object({
    programmId: programmIdFilter.optional(),
    mandantId: z.uuid().optional(),
    aktion: aktionPraefix.optional(),
    nach: posZahl.optional(),
    vor: posZahl.optional(),
    limit: z.number().int().min(1).max(MAX_AUDIT_JE_SEITE).optional(),
  })
  .strict()
  .superRefine(auditRegeln);
export type AuditListeEingabe = z.input<typeof AuditListeEingabeSchema>;

/** Query von `GET /v1/audit` (Zahlen als Text). */
export const AuditQuerySchema = z
  .object({
    programmId: programmIdFilter.optional(),
    mandantId: z.uuid().optional(),
    aktion: aktionPraefix.optional(),
    nach: zahlText.optional(),
    vor: zahlText.optional(),
    limit: zahlText.pipe(z.number().int().min(1).max(MAX_AUDIT_JE_SEITE)).optional(),
  })
  .strict()
  .superRefine(auditRegeln);

const auditEintrag = z
  .object({
    /** Laufende Position im Tenant (1, 2, 3, …). */
    pos: z.number().int().min(1),
    at: zeitpunkt,
    actorId: text(200).nullable(),
    actorName: text(200),
    aktion: text(200),
    objektTyp: text(200),
    objektId: text(200),
    programmId: text(200).nullable(),
    /** Mandant des Programms (Zuordnung für die Anzeige), sonst null. */
    mandantId: z.uuid().nullable(),
    detail: z.json(),
    prevHash: z.string().regex(/^[0-9a-f]{64}$/),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** Antwort von `GET /v1/audit`: eine Seite und der Cursor für die nächste. */
export const AuditListeAntwortSchema = z
  .object({
    eintraege: z.array(auditEintrag),
    /** Position für `nach` bzw. `vor` der nächsten Seite; null = keine weitere. */
    weiter: z.number().int().nullable(),
    /** Letzter Eintrag der Kette (unabhängig vom Filter). */
    kopf: z
      .object({
        pos: z.number().int().min(1),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        at: zeitpunkt,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type AuditListeAntwort = z.infer<typeof AuditListeAntwortSchema>;

/**
 * Body von `POST /v1/audit/pruefen`: ohne `ab` von Beginn der Kette; mit `ab`
 * Fortsetzung nach einer abgebrochenen Prüfung (Einträge nach dieser
 * Position, verkettet mit dem gespeicherten Hash an `ab`).
 */
export const AuditPruefenEingabeSchema = z.object({ ab: posZahl.optional() }).strict();
export type AuditPruefenEingabe = z.input<typeof AuditPruefenEingabeSchema>;

export const AuditPruefenAntwortSchema = z
  .object({
    status: z.enum(['INTAKT', 'GEBROCHEN', 'ABGEBROCHEN']),
    /** Anzahl geprüfter Einträge in diesem Aufruf. */
    geprueft: z.number().int(),
    /** Erste Position, an der die Kette bricht. */
    bruchBei: z.number().int().nullable(),
    grund: text(200).nullable(),
    /** Bei ABGEBROCHEN: Wert für `ab` des nächsten Aufrufs. */
    weiterAb: z.number().int().nullable(),
  })
  .strict();
export type AuditPruefenAntwort = z.infer<typeof AuditPruefenAntwortSchema>;
