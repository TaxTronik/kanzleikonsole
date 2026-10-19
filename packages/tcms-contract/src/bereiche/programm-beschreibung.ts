// =============================================================================
// Vertrag (zod) des Bereichs „programm-beschreibung" (Welle 2): Eingaben und
// Antworten für Einrichtungsassistent, CMS-Beschreibung, Freigaben (Kanzlei
// und Portal), Kommunikation und Postausgang.
//
// Grundsätze:
//   - Eingaben sind strikt (unbekannte Felder → UNGUELTIG). Die Service-
//     Funktionen prüfen dieselben Schemas noch einmal (die Demo ruft ohne HTTP).
//   - Bodys enthalten nie `mandantId`; sie kommt aus dem Pfad (Mandantenbindung,
//     ADR 0001 §3.3). Eingabe = Body + Pfadparameter.
//   - Schreibende Operationen nehmen keinen Stichtag an (TS-07).
//   - Personen sind IDs der kanzleikonsole. Wo eine Operation Namen braucht
//     (eingefrorene Beschreibung), kommen sie als ausdrückliche Eingabe und
//     werden nie für Rechte verwendet (ADR 0001 §5, Nachtrag Welle 2).
//   - Antworten sind JSON: Zeitpunkte als ISO-Strings, keine Codes, keine
//     Code-Hashes (Freigabe-Codes erreichen den Empfänger nur über den
//     Postausgang).
// Dieses Modul hängt nur von zod ab (die kanzleikonsole importiert es); die
// Gleichheit mit den Typen aus @tcms/domain prüft der Service beim Übersetzen.
// =============================================================================

import { z } from 'zod';
import { StandSchema } from './lesepfade';
import { ProfilAntwortenSchema } from './risiken-kontrollen';

const uuid = z.uuid();
/** ID eines Tax-CMS-Objekts (cuid). */
const objektId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const isoZeit = z.string().max(40);
const isoTag = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const klasse = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']);
const governanceTyp = z.enum(['FP', 'FF', 'IN']);
const turnus = z.enum(['KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH']);
const partei = z.enum(['KANZLEI', 'MANDANT']);

/** Person der kanzleikonsole mit Anzeigenamen (nur Anzeige, nie für Rechte). */
const namensEintrag = z.object({ id: uuid, name: z.string().trim().min(1).max(200) }).strict();

// -----------------------------------------------------------------------------
// Postausgang (Zustellung durch die kanzleikonsole, Stufe 4)
// -----------------------------------------------------------------------------

export const NACHRICHT_ZWECKE = [
  /** Hinweis auf eine neue Anforderung (ohne Code). */
  'FREIGABE_ANGEFORDERT',
  /** Bestätigungscode für genau eine Freigabe. */
  'FREIGABE_CODE',
  /** Die Kanzlei hat eine Anforderung an diese Person neu adressiert (ohne Code). */
  'FREIGABE_NEU_ADRESSIERT',
  /** Ein Mandantenkontakt hat im Portal ein Ereignis gemeldet (an die zuständige Kanzleiperson). */
  'EREIGNIS_GEMELDET',
] as const;
export const NachrichtZweckSchema = z.enum(NACHRICHT_ZWECKE);
export type NachrichtZweck = z.infer<typeof NachrichtZweckSchema>;
export const MAX_NACHRICHTEN_JE_ABRUF = 100;

export const NachrichtenOffenQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(MAX_NACHRICHTEN_JE_ABRUF))
      .optional(),
  })
  .strict();
export const NachrichtenOffenEingabeSchema = z
  .object({ limit: z.number().int().min(1).max(MAX_NACHRICHTEN_JE_ABRUF).optional() })
  .strict();
export type NachrichtenOffenEingabe = z.infer<typeof NachrichtenOffenEingabeSchema>;
export const OffeneNachrichtSchema = z
  .object({
    id: z.string(),
    empfaengerId: z.string(),
    zweck: NachrichtZweckSchema,
    betreff: z.string(),
    text: z.string(),
    erstelltAm: isoZeit,
  })
  .strict();
export type OffeneNachricht = z.infer<typeof OffeneNachrichtSchema>;
export const NachrichtenOffenSchema = z
  .object({ nachrichten: z.array(OffeneNachrichtSchema) })
  .strict();

export const NachrichtZugestelltEingabeSchema = z.object({ nachrichtId: objektId }).strict();
export type NachrichtZugestelltEingabe = z.infer<typeof NachrichtZugestelltEingabeSchema>;
export const NachrichtZugestelltErgebnisSchema = z
  .object({ nachrichtId: z.string(), zugestellt: z.literal(true) })
  .strict();
export type NachrichtZugestelltErgebnis = z.infer<typeof NachrichtZugestelltErgebnisSchema>;

// -----------------------------------------------------------------------------
// Einrichtungsassistent (Schritte 1–5, Version 1)
// -----------------------------------------------------------------------------

export const SetupTurnusSchema = z.enum(['MONATLICH', 'QUARTALSWEISE', 'JAEHRLICH']);
export const SetupAppetitSchema = z.enum(['GERING', 'MITTEL', 'HOCH']);
/** Katalogcode eines Risikos bzw. einer Kontrolle (z. B. EC-UST-01, K-EC-01). */
const katalogCode = z
  .string()
  .min(3)
  .max(20)
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/);
const kurz = z.string().trim().max(200);
const tagOderLeer = isoTag.or(z.literal(''));

export const TeilbereichSchrittSchema = z
  .object({
    teilbereich: z
      .object({
        name: z.string().trim().min(1).max(200),
        abgrenzung: z.string().trim().max(4000),
        einschluesse: z.array(kurz).max(30),
        ausschluesse: z.array(kurz).max(30),
      })
      .strict(),
    zeitraum: z
      .object({
        angemessenheitStichtag: tagOderLeer,
        wirksamAb: tagOderLeer,
        wirksamBis: tagOderLeer,
        erklaerungsTurnus: SetupTurnusSchema,
      })
      .strict(),
  })
  .strict();

/** Geschäftsprofil P1–P12: ein Schema für Einrichtung und Profiländerung (`ProfilAntwortenSchema`). */
export const ProfilSchrittSchema = z.object({ profil: ProfilAntwortenSchema }).strict();

export const EntwurfZielSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9_-]+$/),
    text: z.string().trim().max(1000),
    wesentlichkeitEur: z.number().int().min(0).max(1e9),
    risikoappetit: SetupAppetitSchema,
    aktiv: z.boolean(),
    eigen: z.boolean(),
  })
  .strict();

export const ZieleSchrittSchema = z
  .object({
    ziele: z.array(EntwurfZielSchema).max(20),
    /** Freigabe der Ziele bei einer gesetzlichen Vertretung (ID der kanzleikonsole). */
    freigabe: z.object({ anfordern: z.boolean(), empfaengerId: uuid.nullable() }).strict(),
  })
  .strict();

export const EntwurfRisikoSchema = z
  .object({ uebernehmen: z.boolean(), begruendung: z.string().trim().max(2000) })
  .strict();

export const RisikenSchrittSchema = z
  .object({ risiken: z.record(katalogCode, EntwurfRisikoSchema) })
  .strict();

export const EntwurfKontrolleSchema = z
  .object({
    partei,
    durchfuehrendId: uuid.nullable(),
    vertretungId: uuid.nullable(),
    gegenzeichnerId: uuid.nullable(),
  })
  .strict();

export const KontrollenSchrittSchema = z
  .object({ kontrollen: z.record(katalogCode, EntwurfKontrolleSchema) })
  .strict();

/** Gespeicherter Entwurf (TcmsProgramm.setupEntwurf), wie ihn der Service liefert. */
export const SetupEntwurfSchema = z
  .object({
    v: z.literal(1),
    /** Höchster geprüft abgeschlossener Schritt (0–5). */
    abgeschlossen: z.number().int().min(0).max(5),
    teilbereich: TeilbereichSchrittSchema.shape.teilbereich,
    zeitraum: TeilbereichSchrittSchema.shape.zeitraum,
    profil: ProfilAntwortenSchema,
    ziele: ZieleSchrittSchema.shape.ziele,
    freigabe: ZieleSchrittSchema.shape.freigabe,
    risiken: RisikenSchrittSchema.shape.risiken,
    kontrollen: KontrollenSchrittSchema.shape.kontrollen,
    /** Person (ID), die zuletzt gespeichert hat. */
    gespeichertVon: uuid.nullable().optional(),
    gespeichertAm: isoZeit.nullable().optional(),
  })
  .strict();

export type SetupEntwurf = z.infer<typeof SetupEntwurfSchema>;
export type EntwurfZiel = z.infer<typeof EntwurfZielSchema>;
export type EntwurfRisiko = z.infer<typeof EntwurfRisikoSchema>;
export type EntwurfKontrolle = z.infer<typeof EntwurfKontrolleSchema>;

/**
 * Personen der Kanzlei für Vorbelegung und Prüfung der Zuständigkeiten
 * (ausdrückliche Eingabe der kanzleikonsole, nie für Rechte): zuständige:r
 * Berufsträger:in, Hauptbearbeitung und alle Kanzleipersonen mit Zugriff auf
 * den Mandanten (Reihenfolge = Vorschlagsreihenfolge für die Vertretung).
 */
export const EinrichtungPersonenSchema = z
  .object({
    berufstraegerId: uuid.nullable(),
    bearbeitungId: uuid.nullable(),
    kanzlei: z.array(uuid).max(2000),
  })
  .strict();
export type EinrichtungPersonen = z.infer<typeof EinrichtungPersonenSchema>;

/**
 * Einrichtung lesen (GET, ohne Body): Zuständigkeit und eine Vertretung der
 * Kanzlei für die Vorbelegung (nur Anzeige). Die vollständige Liste der
 * Kanzleipersonen braucht erst das Speichern bzw. Anlegen.
 */
export const EinrichtungLesenQuerySchema = z
  .object({
    berufstraegerId: uuid.optional(),
    bearbeitungId: uuid.optional(),
    vertretungId: uuid.optional(),
  })
  .strict();
export const EinrichtungLesenEingabeSchema = EinrichtungLesenQuerySchema.extend({
  mandantId: uuid,
}).strict();
export type EinrichtungLesenEingabe = z.infer<typeof EinrichtungLesenEingabeSchema>;

const ZielAktion = z.enum(['speichern', 'weiter', 'zurueck']);

function entwurfVarianten<M extends z.ZodRawShape>(basis: M) {
  const v = <S extends z.ZodRawShape>(s: S) =>
    z.object({ ...basis, ziel: ZielAktion, personen: EinrichtungPersonenSchema, ...s }).strict();
  return z.discriminatedUnion('schritt', [
    v({ schritt: z.literal(1), daten: TeilbereichSchrittSchema }),
    v({ schritt: z.literal(2), daten: ProfilSchrittSchema }),
    v({ schritt: z.literal(3), daten: ZieleSchrittSchema }),
    v({ schritt: z.literal(4), daten: RisikenSchrittSchema }),
    v({ schritt: z.literal(5), daten: KontrollenSchrittSchema }),
  ]);
}

/** Einen Schritt speichern (`speichern`), prüfen und abschließen (`weiter`) oder zurück. */
export const EntwurfSpeichernBodySchema = entwurfVarianten({});
export const EntwurfSpeichernEingabeSchema = entwurfVarianten({ mandantId: uuid });
export type EntwurfSpeichernEingabe = z.infer<typeof EntwurfSpeichernEingabeSchema>;

export const EntwurfSpeichernErgebnisSchema = z
  .object({
    programmId: z.string(),
    /** Das Programm wurde mit diesem Aufruf angelegt (Status ENTWURF). */
    angelegt: z.boolean(),
    abgeschlossen: z.number().int().min(0).max(5),
    geaendert: z.boolean(),
  })
  .strict();
export type EntwurfSpeichernErgebnis = z.infer<typeof EntwurfSpeichernErgebnisSchema>;

/** Version 1 anlegen: Zuständigkeiten aus Schritt 5 und Personen (wie beim Speichern). */
export const ProgrammAnlegenBodySchema = z
  .object({ daten: KontrollenSchrittSchema, personen: EinrichtungPersonenSchema })
  .strict();
export const ProgrammAnlegenEingabeSchema = ProgrammAnlegenBodySchema.extend({
  mandantId: uuid,
}).strict();
export type ProgrammAnlegenEingabe = z.infer<typeof ProgrammAnlegenEingabeSchema>;

export const ProgrammAnlegenErgebnisSchema = z
  .object({
    programmId: z.string(),
    risiken: z.number().int(),
    abgelehnt: z.number().int(),
    kontrollen: z.number().int(),
    durchfuehrungen: z.number().int(),
    ziele: z.number().int(),
    /** Freigabe der Ziele, falls angefordert. */
    freigabeId: z.string().nullable(),
  })
  .strict();
export type ProgrammAnlegenErgebnis = z.infer<typeof ProgrammAnlegenErgebnisSchema>;

const FrequenzSchema = z.object({ turnus, anlass: z.boolean() }).strict();

export const PlanViewSchema = z
  .object({
    appetit: klasse,
    zeitraum: z.object({ stichtag: isoTag, ab: isoTag, bis: isoTag }).strict().nullable(),
    risiken: z.array(
      z
        .object({
          code: z.string(),
          titel: z.string(),
          kern: z.boolean(),
          gt: governanceTyp,
          grund: z.string(),
          frage: z.string(),
          uebernehmen: z.boolean(),
          begruendung: z.string(),
          brutto: klasse,
          ueberAppetit: z.boolean(),
        })
        .strict(),
    ),
    nichtVorgeschlagen: z.array(z.object({ code: z.string(), titel: z.string() }).strict()),
    kontrollen: z.array(
      z
        .object({
          code: z.string(),
          titel: z.string(),
          schluessel: z.boolean(),
          risikoCodes: z.array(z.string()),
          primaer: z.string().nullable(),
          vorlage: FrequenzSchema,
          effektiv: FrequenzSchema,
          gt: governanceTyp.nullable(),
          begruendung: z.string(),
          zust: EntwurfKontrolleSchema.extend({ gegenzeichnungMandant: z.boolean() }).strict(),
          perioden: z.number().int(),
        })
        .strict(),
    ),
    prueflast: z.array(
      z
        .object({
          monat: z.string(),
          FP: z.number(),
          FF: z.number(),
          IN: z.number(),
          ausloesungen: z.number(),
          gesamt: z.number(),
        })
        .strict(),
    ),
    durchfuehrungen: z.number().int(),
  })
  .strict();
export type PlanView = z.infer<typeof PlanViewSchema>;

export const EinrichtungViewSchema = z
  .object({
    programm: z
      .object({
        id: z.string(),
        status: z.enum(['ENTWURF', 'AKTIV']),
        version1Am: isoZeit.nullable(),
        createdAt: isoZeit,
      })
      .strict()
      .nullable(),
    /** Version 1 ist angelegt: Der Assistent ist geschlossen. */
    eingerichtet: z.boolean(),
    entwurf: SetupEntwurfSchema.nullable(),
    plan: PlanViewSchema.nullable(),
    /** Offene Punkte je Schritt (leer = vollständig). */
    pruefung: z.array(
      z.object({ schritt: z.number().int(), fehler: z.array(z.string()) }).strict(),
    ),
    /** Gesetzliche Vertretungen des Mandanten (IDs aus MandantKontaktRolle). */
    gesetzlicheVertreter: z.array(z.string()),
    /** Darf der Akteur den Entwurf ändern (Bearbeitungsrecht)? */
    darfBearbeiten: z.boolean(),
  })
  .strict();
export type EinrichtungView = z.infer<typeof EinrichtungViewSchema>;

// -----------------------------------------------------------------------------
// CMS-Beschreibung
// -----------------------------------------------------------------------------

export const BESCHREIBUNG_ABSCHNITT_KEYS = [
  'teilbereich',
  'kultur',
  'ziele',
  'risiken',
  'programm',
  'organisation',
  'kommunikation',
  'ueberwachung',
  'anhang',
] as const;
export const BESCHREIBUNG_BAUSTEIN_ARTEN = [
  'TEILBEREICH',
  'ZIELE',
  'RISIKOINVENTAR',
  'KONTROLLMATRIX',
  'VERANTWORTUNG',
  'LAENDER',
  'FESTSTELLUNGEN',
] as const;
export const BeschreibungAbschnittKeySchema = z.enum(BESCHREIBUNG_ABSCHNITT_KEYS);
export const BeschreibungBausteinArtSchema = z.enum(BESCHREIBUNG_BAUSTEIN_ARTEN);
/** Höchstlänge eines Textblocks (Zeichen). */
export const BESCHREIBUNG_MAX_TEXTBLOCK = 20_000;
/** Höchstzahl Blöcke je Abschnitt. */
export const BESCHREIBUNG_MAX_BLOECKE = 20;

export const BeschreibungBlockSchema = z.discriminatedUnion('typ', [
  z.object({ typ: z.literal('text'), text: z.string().max(BESCHREIBUNG_MAX_TEXTBLOCK) }).strict(),
  z.object({ typ: z.literal('baustein'), art: BeschreibungBausteinArtSchema }).strict(),
]);
export const BeschreibungAbschnittSchema = z
  .object({
    key: BeschreibungAbschnittKeySchema,
    bloecke: z.array(BeschreibungBlockSchema).max(BESCHREIBUNG_MAX_BLOECKE),
  })
  .strict();

const ZieleDaten = z.object({
  appetit: klasse,
  ziele: z.array(
    z.object({
      text: z.string(),
      wesentlichkeitEur: z.number(),
      risikoappetit: klasse,
      freigabe: z.enum(['ENTWURF', 'AUSSTEHEND', 'FREIGEGEBEN']),
      freigegebenAm: z.string().nullable(),
      freigegebenVon: z.string().nullable(),
      freigegebenVonId: z.string().nullable().optional(),
    }),
  ),
});

/** Daten der lebenden Bausteine (JSON-flach; Personen als Name und – neu – als ID). */
export const BausteinSatzSchema = z.object({
  TEILBEREICH: z
    .object({
      name: z.string(),
      abgrenzung: z.string(),
      einschluesse: z.array(z.string()),
      ausschluesse: z.array(z.string()),
      zielLaender: z.array(z.string()),
      kanaele: z.array(z.string()),
    })
    .nullable(),
  ZIELE: ZieleDaten,
  RISIKOINVENTAR: z.object({
    appetit: klasse,
    sicht: z.enum(['DESIGN', 'BETRIEB']),
    risiken: z.array(
      z.object({
        code: z.string(),
        titel: z.string(),
        gt: governanceTyp,
        brutto: klasse,
        netto: klasse,
        ueberAppetit: z.boolean(),
        kontrollen: z.number(),
      }),
    ),
  }),
  KONTROLLMATRIX: z.object({
    kontrollen: z.array(
      z.object({
        code: z.string(),
        titel: z.string(),
        art: z.enum(['P', 'D', 'K']),
        frequenz: z.string(),
        partei,
        schluessel: z.boolean(),
        design: z.enum(['ANGEMESSEN', 'NICHT_BEURTEILT', 'MANGEL']),
        designVon: z.string().nullable(),
        designVonId: z.string().nullable().optional(),
        designAm: z.string().nullable(),
        risikoCodes: z.array(z.string()),
      }),
    ),
  }),
  VERANTWORTUNG: z.object({
    rollen: z.array(
      z.object({ rolle: z.string(), name: z.string(), personId: z.string().nullable().optional() }),
    ),
    kontrollen: z.array(
      z.object({
        code: z.string(),
        titel: z.string(),
        partei,
        durchfuehrend: z.string(),
        vertretung: z.string(),
        gegenzeichnung: z.string(),
        durchfuehrendId: z.string().nullable().optional(),
        vertretungId: z.string().nullable().optional(),
        gegenzeichnungId: z.string().nullable().optional(),
      }),
    ),
  }),
  LAENDER: z.object({
    stand: z.string().nullable(),
    summeLfd: z.number(),
    summeVorjahr: z.number(),
    schwelle: z.string(),
    laender: z.array(
      z.object({
        land: z.string(),
        name: z.string(),
        fernverkaeufeLfdEur: z.number(),
        lagerSeit: z.string().nullable(),
        oss: z.boolean(),
        lokaleUstNr: z.boolean(),
        registrierung: z.enum(['VOLLSTAENDIG', 'FEHLT', 'PRUEFEN']),
      }),
    ),
  }),
  FESTSTELLUNGEN: z.object({
    feststellungen: z.array(
      z.object({
        nummer: z.string(),
        titel: z.string(),
        schwere: klasse,
        status: z.string(),
        massnahmenOffen: z.number(),
      }),
    ),
  }),
});
export type BausteinSatzDaten = z.infer<typeof BausteinSatzSchema>;

/** Eingefrorener Inhalt einer Beschreibungsversion (SHA-256 über kanonisches JSON). */
export const BeschreibungSnapshotSchema = z.object({
  nummer: z.string(),
  mandant: z.string(),
  eingefroren: z.literal(true),
  stand: z.string().optional(),
  erzeugtAm: z.string().optional(),
  abschnitte: z.array(BeschreibungAbschnittSchema),
  bausteine: BausteinSatzSchema.partial().optional(),
});

export type BeschreibungSnapshot = z.infer<typeof BeschreibungSnapshotSchema>;
export type BeschreibungAbschnitt = z.infer<typeof BeschreibungAbschnittSchema>;

export const BESCHREIBUNG_STATUS = [
  'ENTWURF',
  'KANZLEI_REVIEW',
  'BEIM_MANDANTEN',
  'FREIGEGEBEN',
  'ABGELOEST',
] as const;
const beschreibungStatus = z.enum(BESCHREIBUNG_STATUS);
const freigabeStatus = z.enum(['OFFEN', 'FREIGEGEBEN', 'ABGELEHNT']);
export const FREIGABE_ARTEN = [
  'ZIELE',
  'BESCHREIBUNG',
  'RISIKOAKZEPTANZ',
  'AUFKLAERUNG',
  'KENNTNISNAHME',
] as const;
const freigabeArt = z.enum(FREIGABE_ARTEN);

/** Zustand des Bestätigungscodes einer Freigabe (nie der Code oder sein Hash). */
export const FreigabeCodeStatusSchema = z.enum(['KEIN', 'AKTIV', 'ABGELAUFEN', 'GESPERRT']);
export type FreigabeCodeStatus = z.infer<typeof FreigabeCodeStatusSchema>;

export const BeschreibungVersionViewSchema = z
  .object({
    id: z.string(),
    nummer: z.string(),
    /** gespeicherter (aktueller) Status */
    status: beschreibungStatus,
    /** Status zum Stichtag (aus den Zeitstempeln abgeleitet; aktuell = status) */
    anzeige: beschreibungStatus,
    abschnitte: z.array(BeschreibungAbschnittSchema),
    createdAt: isoZeit,
    erstelltVon: z.string().nullable(),
    reviewAngefordertVon: z.string().nullable(),
    reviewAngefordertAm: isoZeit.nullable(),
    reviewVon: z.string().nullable(),
    reviewAm: isoZeit.nullable(),
    freigabeAngefordertAm: isoZeit.nullable(),
    freigegebenVon: z.string().nullable(),
    freigegebenAm: isoZeit.nullable(),
    snapshot: BeschreibungSnapshotSchema.nullable(),
    snapshotSha256: z.string().nullable(),
    /** SHA-256 des Snapshots stimmt (null: nichts zu prüfen). */
    snapshotGeprueft: z.boolean().nullable(),
    /** Letzte bearbeitende Person (Vier-Augen der Kanzlei-Review). */
    letzteBearbeitung: z.string().nullable(),
  })
  .strict();
export type BeschreibungVersionView = z.infer<typeof BeschreibungVersionViewSchema>;

export const BeschreibungFreigabeViewSchema = z
  .object({
    id: z.string(),
    refId: z.string(),
    status: freigabeStatus,
    angefordertVon: z.string(),
    angefordertAm: isoZeit,
    empfaengerId: z.string(),
    codeStatus: FreigabeCodeStatusSchema,
    codeAblauf: isoZeit.nullable(),
    anmerkung: z.string().nullable(),
    erledigtAm: isoZeit.nullable(),
  })
  .strict();

export const BeschreibungLesenQuerySchema = z
  .object({
    stand: StandSchema.optional(),
    /** Zuständigkeit für den Baustein VERANTWORTUNG (nur Anzeige). */
    berufstraegerId: uuid.optional(),
    bearbeitungId: uuid.optional(),
  })
  .strict();
export const BeschreibungLesenEingabeSchema = BeschreibungLesenQuerySchema.extend({
  mandantId: uuid,
}).strict();
export type BeschreibungLesenEingabe = z.infer<typeof BeschreibungLesenEingabeSchema>;

export const BeschreibungViewSchema = z
  .object({
    programmId: z.string().nullable(),
    stand: isoTag,
    historisch: z.boolean(),
    versionen: z.array(BeschreibungVersionViewSchema),
    freigaben: z.array(BeschreibungFreigabeViewSchema),
    zurueckweisungen: z.array(
      z
        .object({
          versionId: z.string(),
          nummer: z.string(),
          at: isoZeit,
          actorId: z.string().nullable(),
          begruendung: z.string(),
        })
        .strict(),
    ),
    /** Lebende Bausteine zum Stichtag (für Entwürfe und die Vorschau). */
    bausteine: BausteinSatzSchema.nullable(),
    gesetzlicheVertreter: z.array(z.string()),
    darfBearbeiten: z.boolean(),
    /** Anzeigenamen über das Personenverzeichnis (im Dienst leer). */
    namen: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  })
  .strict();
export type BeschreibungView = z.infer<typeof BeschreibungViewSchema>;

const versionPfad = { mandantId: uuid, versionId: objektId };

export const BeschreibungVersionAnlegenEingabeSchema = z.object({ mandantId: uuid }).strict();
export const BeschreibungVersionAnlegenErgebnisSchema = z
  .object({ versionId: z.string(), nummer: z.string(), basis: z.string().nullable() })
  .strict();

export const AbschnittSpeichernBodySchema = z
  .object({
    key: BeschreibungAbschnittKeySchema,
    bloecke: z.array(BeschreibungBlockSchema).min(1).max(BESCHREIBUNG_MAX_BLOECKE),
  })
  .strict();
export const AbschnittSpeichernEingabeSchema =
  AbschnittSpeichernBodySchema.extend(versionPfad).strict();
export type AbschnittSpeichernEingabe = z.infer<typeof AbschnittSpeichernEingabeSchema>;
export const AbschnittSpeichernErgebnisSchema = z
  .object({ versionId: z.string(), nummer: z.string(), geaendert: z.boolean() })
  .strict();

export const BeschreibungVersionAktionEingabeSchema = z.object(versionPfad).strict();
export type BeschreibungVersionAktionEingabe = z.infer<
  typeof BeschreibungVersionAktionEingabeSchema
>;
export const BeschreibungVersionAktionErgebnisSchema = z
  .object({ versionId: z.string(), nummer: z.string(), status: beschreibungStatus })
  .strict();
export type BeschreibungVersionAktionErgebnis = z.infer<
  typeof BeschreibungVersionAktionErgebnisSchema
>;

/** Mindestlänge einer Begründung (wie Übersteuerungen, AGENTS.md Regel 2). */
export const REVIEW_MIN_BEGRUENDUNG = 30;

export const ReviewZurueckweisenBodySchema = z
  .object({ begruendung: z.string().trim().min(REVIEW_MIN_BEGRUENDUNG).max(2000) })
  .strict();
export const ReviewZurueckweisenEingabeSchema =
  ReviewZurueckweisenBodySchema.extend(versionPfad).strict();
export type ReviewZurueckweisenEingabe = z.infer<typeof ReviewZurueckweisenEingabeSchema>;

/**
 * Freigabe beim Mandanten anfordern: Empfänger (gesetzliche Vertretung, ID),
 * Zuständigkeit und Anzeigenamen für den eingefrorenen Inhalt (nur Anzeige).
 */
export const BeschreibungFreigabeAnfordernBodySchema = z
  .object({
    empfaengerId: uuid,
    verantwortung: z
      .object({ berufstraeger: namensEintrag.nullable(), bearbeitung: namensEintrag.nullable() })
      .strict(),
    namen: z.array(namensEintrag).max(2000),
  })
  .strict();
export const BeschreibungFreigabeAnfordernEingabeSchema =
  BeschreibungFreigabeAnfordernBodySchema.extend(versionPfad).strict();
export type BeschreibungFreigabeAnfordernEingabe = z.infer<
  typeof BeschreibungFreigabeAnfordernEingabeSchema
>;
export const BeschreibungFreigabeAnfordernErgebnisSchema = z
  .object({
    versionId: z.string(),
    nummer: z.string(),
    freigabeId: z.string(),
    snapshotSha256: z.string(),
    codeAblauf: isoZeit,
    /** Zurückgezogene ältere Anforderungen (Versionsnummern). */
    zurueckgezogen: z.array(z.string()),
  })
  .strict();
export type BeschreibungFreigabeAnfordernErgebnis = z.infer<
  typeof BeschreibungFreigabeAnfordernErgebnisSchema
>;

// -----------------------------------------------------------------------------
// Freigaben: Neuadressierung (Kanzlei) und Portal
// -----------------------------------------------------------------------------

/** Bestätigungscode: genau sechs Ziffern. */
export const FreigabeCodeSchema = z.string().regex(/^\d{6}$/);

export const FreigabeNeuadressierungBodySchema = z.object({ empfaengerId: uuid }).strict();
export const FreigabeNeuadressierungEingabeSchema = FreigabeNeuadressierungBodySchema.extend({
  mandantId: uuid,
  freigabeId: objektId,
}).strict();
export type FreigabeNeuadressierungEingabe = z.infer<typeof FreigabeNeuadressierungEingabeSchema>;
export const FreigabeNeuadressierungErgebnisSchema = z
  .object({ freigabeId: z.string(), vorherId: z.string(), empfaengerId: z.string() })
  .strict();

export const PortalFreigabenEingabeSchema = z.object({ mandantId: uuid }).strict();
export type PortalFreigabenEingabe = z.infer<typeof PortalFreigabenEingabeSchema>;

export const PortalFreigabeViewSchema = z
  .object({
    id: z.string(),
    art: freigabeArt,
    titel: z.string(),
    inhalt: z.string().nullable(),
    status: freigabeStatus,
    angefordertVon: z.string(),
    angefordertAm: isoZeit,
    empfaengerId: z.string(),
    erledigtAm: isoZeit.nullable(),
    anmerkung: z.string().nullable(),
    /** Freigabe mit Bestätigungscode (sonst Kenntnisnahme). */
    brauchtCode: z.boolean(),
    istEmpfaenger: z.boolean(),
    darfFreigeben: z.boolean(),
    darfKenntnisnehmen: z.boolean(),
    /** Fachlicher Grund, falls der Akteur nicht handeln darf. */
    sperrgrund: z.string().nullable(),
    /** Nur für die adressierte Person. */
    code: z
      .object({
        status: FreigabeCodeStatusSchema,
        ablauf: isoZeit.nullable(),
        verbleibendeVersuche: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    version: z
      .object({
        id: z.string(),
        nummer: z.string(),
        status: beschreibungStatus,
        abschnitte: z.array(BeschreibungAbschnittSchema),
        snapshot: BeschreibungSnapshotSchema.nullable(),
        snapshotSha256: z.string().nullable(),
        snapshotGeprueft: z.boolean().nullable(),
        freigegebenVon: z.string().nullable(),
        freigegebenAm: isoZeit.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PortalFreigabeView = z.infer<typeof PortalFreigabeViewSchema>;

export const PortalFreigabenViewSchema = z
  .object({
    freigaben: z.array(PortalFreigabeViewSchema),
    /** Freigegebene Beschreibungsversionen ohne eigenen Freigabe-Datensatz. */
    fruehere: z.array(
      z
        .object({
          id: z.string(),
          nummer: z.string(),
          status: beschreibungStatus,
          freigegebenVon: z.string(),
          freigegebenAm: isoZeit,
          snapshotSha256: z.string().nullable(),
        })
        .strict(),
    ),
    /** Lebende Bausteine, falls eine offene Beschreibung noch ohne Snapshot vorliegt. */
    live: z.object({ stand: isoTag, bausteine: BausteinSatzSchema }).strict().nullable(),
    gesetzlicheVertreter: z.array(z.string()),
    istGesetzlicherVertreter: z.boolean(),
    kannPortalLesen: z.boolean(),
    namen: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  })
  .strict();
export type PortalFreigabenView = z.infer<typeof PortalFreigabenViewSchema>;

const portalPfad = { mandantId: uuid, freigabeId: objektId };

/** Pfadparameter der Freigabe-Endpunkte (Kanzlei und Portal, Endpunktregister). */
export const FreigabePfadSchema = z.object(portalPfad).strict();

export const PortalCodeAnfordernEingabeSchema = z.object(portalPfad).strict();
export type PortalCodeAnfordernEingabe = z.infer<typeof PortalCodeAnfordernEingabeSchema>;
export const PortalCodeAnfordernErgebnisSchema = z
  .object({ freigabeId: z.string(), codeAblauf: isoZeit })
  .strict();
export type PortalCodeAnfordernErgebnis = z.infer<typeof PortalCodeAnfordernErgebnisSchema>;

export const PortalFreigebenBodySchema = z.object({ code: FreigabeCodeSchema }).strict();
export const PortalFreigebenEingabeSchema = PortalFreigebenBodySchema.extend(portalPfad).strict();
export type PortalFreigebenEingabe = z.infer<typeof PortalFreigebenEingabeSchema>;
/**
 * Ergebnis eines Freigabeversuchs. Ein falscher Code ist kein Fehler der
 * Anfrage: Der Fehlversuch wird gezählt und protokolliert (dieselbe
 * Transaktion, deshalb 200 statt 4xx); der Aufrufer prüft `freigegeben`.
 */
export const PortalFreigebenErgebnisSchema = z.discriminatedUnion('freigegeben', [
  z.object({ freigegeben: z.literal(true), freigabeId: z.string(), erledigtAm: isoZeit }).strict(),
  z
    .object({
      freigegeben: z.literal(false),
      freigabeId: z.string(),
      grund: z.enum(['CODE_FALSCH', 'GESPERRT']),
      verbleibendeVersuche: z.number().int().min(0),
    })
    .strict(),
]);
export type PortalFreigebenErgebnis = z.infer<typeof PortalFreigebenErgebnisSchema>;

export const PortalKenntnisnahmeBodySchema = z.object({ gelesen: z.literal(true) }).strict();
export const PortalKenntnisnahmeEingabeSchema =
  PortalKenntnisnahmeBodySchema.extend(portalPfad).strict();
export type PortalKenntnisnahmeEingabe = z.infer<typeof PortalKenntnisnahmeEingabeSchema>;
export const PortalKenntnisnahmeErgebnisSchema = z
  .object({ freigabeId: z.string(), erledigtAm: isoZeit })
  .strict();

// -----------------------------------------------------------------------------
// Kommunikation: Freigaben-Historie (Kanzlei)
// -----------------------------------------------------------------------------

export const FreigabenHistorieQuerySchema = z.object({ stand: StandSchema.optional() }).strict();
export const FreigabenHistorieEingabeSchema = FreigabenHistorieQuerySchema.extend({
  mandantId: uuid,
}).strict();
export type FreigabenHistorieEingabe = z.infer<typeof FreigabenHistorieEingabeSchema>;
export const FreigabeHistorieZeileSchema = z
  .object({
    id: z.string(),
    art: freigabeArt,
    titel: z.string(),
    empfaengerId: z.string(),
    angefordertVon: z.string(),
    angefordertAm: isoZeit,
    /** Status zum Stichtag: später erledigte Anforderungen gelten am Stichtag als offen. */
    status: freigabeStatus,
    erledigtAm: isoZeit.nullable(),
    anmerkung: z.string().nullable(),
    codeStatus: FreigabeCodeStatusSchema,
    codeAblauf: isoZeit.nullable(),
  })
  .strict();
export type FreigabeHistorieZeile = z.infer<typeof FreigabeHistorieZeileSchema>;
export const FreigabenHistorieSchema = z
  .object({
    stand: isoTag,
    historisch: z.boolean(),
    freigaben: z.array(FreigabeHistorieZeileSchema),
  })
  .strict();
export type FreigabenHistorie = z.infer<typeof FreigabenHistorieSchema>;
