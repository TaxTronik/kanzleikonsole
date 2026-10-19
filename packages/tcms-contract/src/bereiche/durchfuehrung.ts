// =============================================================================
// Vertrag (zod) des Bereichs „durchfuehrung" (Welle 2): Kontrolldurchführung
// in der Kanzlei (S8) und Kontrollaufgabe im Portal (P2).
//
// Zwei Schichten je Operation:
//   - `…BodySchema`: JSON-Body des Endpunkts (strikt). IDs stehen nie im Body,
//     sondern im Pfad; ein Body mit `mandantId` o. ä. wird abgewiesen.
//   - `…EingabeSchema`: Eingabe der Service-Funktion (Body + IDs aus dem Pfad).
//     Der Service prüft sie selbst noch einmal (die Demo ruft ohne HTTP).
// Schreibende Operationen nehmen keinen Stichtag an (ADR 0001 §7, TS-07).
//
// Antworten sind JSON: Zeitpunkte als ISO-8601 (`…Z`), Kalendertage als
// `YYYY-MM-DD`, Listen statt Map/Set. Personen erscheinen nur als IDs der
// kanzleikonsole; Anzeigenamen liefert `namen` (im Dienst leer, ADR 0001 §5).
// =============================================================================

import { z } from 'zod';
import { VERWEIGERUNG_GRUENDE } from '../fehler';
import { DATEINAME_UNZULAESSIG, einzeilig, mitTextBasis, StandSchema } from './lesepfade';

// ---------------------------------------------------------------------------
// Grenzen und Bausteine
// ---------------------------------------------------------------------------

/** Mindestlänge einer Begründung (Zurückweisen, Entfallen, Nachtrag; AGENTS.md Regel 2/4). */
export const DF_MIN_BEGRUENDUNG = 30;
export const DF_MAX_BEGRUENDUNG = 4000;
/** Mindestlänge der Befundbeschreibung beim Einreichen mit Befund. */
export const DF_MIN_BEFUND_KOMMENTAR = 20;
export const DF_MAX_SCHRITTE = 100;
export const DF_MAX_KENNZAHLEN = 50;
export const DF_MAX_SCHRITT_KOMMENTAR = 2000;
export const DF_MAX_WERT_BEMERKUNG = 1000;
export const DF_MAX_ERGEBNIS_KOMMENTAR = 4000;
/** Beträge (Euro) unterhalb dieser Grenze; zwei Nachkommastellen. */
export const DF_MAX_BETRAG = 1e12;
/** Obergrenze `groesse` eines Nachweises (Spalte INTEGER). */
export const DF_MAX_NACHWEIS_BYTES = 2_147_483_647;

/** Objekt-IDs des Tax-CMS (cuid): nur Kleinbuchstaben und Ziffern. */
const OBJEKT_ID = /^[a-z0-9]{1,64}$/;
const objektId = () => z.string().regex(OBJEKT_ID, 'Ungültige ID');

export const DurchfuehrungIdSchema = objektId();
export const NachweisIdSchema = objektId();
const RisikoIdSchema = objektId();

/** Mandanten-ID der kanzleikonsole; kanonisch in Kleinbuchstaben. */
const MandantIdSchema = z.uuid().transform((s) => s.toLowerCase());

const begruendung = () =>
  mitTextBasis(
    z
      .string()
      .trim()
      .min(DF_MIN_BEGRUENDUNG, `Begründung: mindestens ${DF_MIN_BEGRUENDUNG} Zeichen`)
      .max(DF_MAX_BEGRUENDUNG),
  );

const ziel = {
  mandantId: MandantIdSchema,
  durchfuehrungId: DurchfuehrungIdSchema,
};

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/** Query der Leser (`?stand=YYYY-MM-DD`, ADR 0001 §7). */
export const DurchfuehrungStandQuerySchema = z.object({ stand: StandSchema.optional() }).strict();

export const DurchfuehrungLesenEingabeSchema = z
  .object({ ...ziel, stand: StandSchema.optional() })
  .strict();
export type DurchfuehrungLesenEingabe = z.infer<typeof DurchfuehrungLesenEingabeSchema>;

export const KontrollaufgabenEingabeSchema = z.object({ mandantId: MandantIdSchema }).strict();
export type KontrollaufgabenEingabe = z.infer<typeof KontrollaufgabenEingabeSchema>;

export const NachweisLesenEingabeSchema = z
  .object({ mandantId: MandantIdSchema, nachweisId: NachweisIdSchema })
  .strict();
export type NachweisLesenEingabe = z.infer<typeof NachweisLesenEingabeSchema>;

/** Dokument-ID der kanzleikonsole (UUID); kanonisch in Kleinbuchstaben wie gespeichert. */
const DokumentIdSchema = z.uuid().transform((s) => s.toLowerCase());

/**
 * Nachweise je Dokument (`GET …/nachweise?dokumentId=`): Abgleich offener
 * Verknüpfungen der kanzleikonsole mit ihrer Dokumentenpipeline (ADR 0001
 * §6). Nur Kanzleipersonen mit Leserecht für den Mandanten. `dokumentId` ist
 * Pflicht (der Dienst antwortet sonst `400`); im Query-Schema optional, weil
 * das Register jede Query ohne Parameter zulässt und Pflicht im Service prüft.
 */
export const NachweiseJeDokumentQuerySchema = z
  .object({ dokumentId: DokumentIdSchema.optional() })
  .strict();
export const NachweiseJeDokumentPfadSchema = z.object({ mandantId: MandantIdSchema }).strict();
export const NachweiseJeDokumentEingabeSchema = z
  .object({ mandantId: MandantIdSchema, dokumentId: DokumentIdSchema })
  .strict();
/** Eingabe aus Pfad und Query (Pflicht von `dokumentId` prüft der Dienst mit dem Eingabeschema). */
export type NachweiseJeDokumentEingabe = z.input<typeof NachweiseJeDokumentPfadSchema> &
  z.input<typeof NachweiseJeDokumentQuerySchema>;

/**
 * Jeder Nachweis dieses Mandanten mit der Dokument-ID – auch entfernte
 * (`entfernt: true`; die Bindung der Dokument-ID an Mandant und Inhalt bleibt
 * bestehen, ADR 0001 §6), damit die kanzleikonsole eine Verknüpfung nach dem
 * Entfernen freigibt bzw. eine bestätigt. Eine Dokument-ID eines anderen
 * Mandanten oder eine unbekannte ergibt dieselbe leere Liste (kein
 * Existenz-Orakel). Keine Dateinamen, Hashes oder Personen.
 */
export const NachweiseJeDokumentSchema = z
  .object({
    dokumentId: z.string(),
    nachweise: z.array(
      z
        .object({
          id: z.string(),
          durchfuehrungId: z.string(),
          /** Verweis entfernt (vor der Einreichung); sonst aktiv. */
          entfernt: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type NachweiseJeDokument = z.infer<typeof NachweiseJeDokumentSchema>;

// ---------------------------------------------------------------------------
// Operationen ohne Body (beginnen, einreichen, bestätigen, Entfallen freigeben)
// ---------------------------------------------------------------------------

export const DurchfuehrungZielSchema = z.object(ziel).strict();
export type DurchfuehrungZiel = z.infer<typeof DurchfuehrungZielSchema>;

// ---------------------------------------------------------------------------
// Speichern (Schritte, Werte, Ergebnisvorschlag)
// ---------------------------------------------------------------------------

export const DurchfuehrungSchrittEingabeSchema = z
  .object({
    erledigt: z.boolean(),
    kommentar: mitTextBasis(z.string().trim().max(DF_MAX_SCHRITT_KOMMENTAR)),
  })
  .strict();

/** Schlüssel einer Kennzahl; `__proto__` & Co. sind ausgeschlossen (Werte als Liste, nicht als Objekt). */
export const DurchfuehrungKennzahlKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);

export const DurchfuehrungWertEingabeSchema = z
  .object({
    key: DurchfuehrungKennzahlKeySchema,
    wert: z.number().gt(-DF_MAX_BETRAG).lt(DF_MAX_BETRAG).nullable(),
    bemerkung: mitTextBasis(z.string().trim().max(DF_MAX_WERT_BEMERKUNG)),
    erklaert: z.boolean(),
  })
  .strict();

export const DurchfuehrungErgebnisSchema = z.enum(['OHNE_BEFUND', 'MIT_BEFUND']);

const speichernFelder = {
  schritte: z.array(DurchfuehrungSchrittEingabeSchema).max(DF_MAX_SCHRITTE),
  werte: z
    .array(DurchfuehrungWertEingabeSchema)
    .max(DF_MAX_KENNZAHLEN)
    .refine((w) => new Set(w.map((x) => x.key)).size === w.length, 'Kennzahl doppelt'),
  ergebnis: DurchfuehrungErgebnisSchema.nullable(),
  ergebnisKommentar: mitTextBasis(z.string().trim().max(DF_MAX_ERGEBNIS_KOMMENTAR)).nullable(),
};

export const DurchfuehrungSpeichernBodySchema = z.object(speichernFelder).strict();
export const DurchfuehrungSpeichernEingabeSchema = z
  .object({ ...ziel, ...speichernFelder })
  .strict();
export type DurchfuehrungSpeichernEingabe = z.infer<typeof DurchfuehrungSpeichernEingabeSchema>;

// ---------------------------------------------------------------------------
// Nachweise (Verweise der kanzleikonsole, ADR 0001 §6)
// ---------------------------------------------------------------------------

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
// Steuer-, Richtungs-, Nullbreiten- und Füllzeichen, Pfadtrenner
// (Dateinamen-Spoofing): eine Regel für alle Dateinamen (lesepfade.ts).
const DATEINAME_VERBOTEN = DATEINAME_UNZULAESSIG;

/** Gültiger Dateiname eines Verweises (strenger als `pruefeVerweis`, nie lockerer). */
export function gueltigerNachweisDateiname(name: string): boolean {
  return (
    name.trim().length > 0 &&
    name.length <= 255 &&
    !DATEINAME_VERBOTEN.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/**
 * Verweis auf ein Dokument der kanzleikonsole: Dokument-ID (UUID, kanonisch
 * klein), Dateiname, MIME-Typ, Größe in Bytes, SHA-256 (hex, klein). Dateien
 * nimmt nur die kanzleikonsole an.
 */
export const NachweisVerweisSchema = z
  .object({
    dokumentId: z.uuid().transform((s) => s.toLowerCase()),
    dateiname: z.string().max(255).refine(gueltigerNachweisDateiname, 'Ungültiger Dateiname'),
    mime: z.string().max(127).regex(MIME, 'Ungültiger MIME-Typ'),
    groesse: z.number().int().min(1).max(DF_MAX_NACHWEIS_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Ungültiger SHA-256'),
  })
  .strict();
export type NachweisVerweisEingabe = z.infer<typeof NachweisVerweisSchema>;

export const NachweisAnhaengenBodySchema = z.object({ verweis: NachweisVerweisSchema }).strict();
export const NachweisAnhaengenEingabeSchema = z
  .object({ ...ziel, verweis: NachweisVerweisSchema })
  .strict();
export type NachweisAnhaengenEingabe = z.infer<typeof NachweisAnhaengenEingabeSchema>;

export const NachweisEntfernenEingabeSchema = z
  .object({ ...ziel, nachweisId: NachweisIdSchema })
  .strict();
export type NachweisEntfernenEingabe = z.infer<typeof NachweisEntfernenEingabeSchema>;

// ---------------------------------------------------------------------------
// Zurückweisen, Entfallen, Nachtrag
// ---------------------------------------------------------------------------

export const DurchfuehrungBegruendungBodySchema = z.object({ begruendung: begruendung() }).strict();
export const DurchfuehrungBegruendungEingabeSchema = z
  .object({ ...ziel, begruendung: begruendung() })
  .strict();
export type DurchfuehrungBegruendungEingabe = z.infer<typeof DurchfuehrungBegruendungEingabeSchema>;

/**
 * Entfallen-Antrag ablehnen bzw. zurückziehen: Die antragstellende Person zieht
 * ohne Begründung zurück; jede andere Person lehnt mit Begründung ab (Service).
 */
const ablehnenFelder = {
  begruendung: mitTextBasis(z.string().trim().max(DF_MAX_BEGRUENDUNG)).optional(),
};
export const EntfallenAblehnenBodySchema = z.object(ablehnenFelder).strict();
export const EntfallenAblehnenEingabeSchema = z.object({ ...ziel, ...ablehnenFelder }).strict();
export type EntfallenAblehnenEingabe = z.infer<typeof EntfallenAblehnenEingabeSchema>;

// ---------------------------------------------------------------------------
// Gegenzeichnen (mit Feststellung bei Befund)
// ---------------------------------------------------------------------------

const FeststellungKlasseSchema = z.enum(
  ['DESIGNMANGEL', 'DURCHFUEHRUNGSMANGEL', 'STEUERLICHER_FEHLER', 'HINWEIS'],
  { message: 'Klasse wählen' },
);
const KlasseSchema = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH'], {
  message: 'Schwere wählen',
});
const AuswirkungSchema = z.enum(['JA', 'NEIN', 'UNKLAR'], {
  message: 'Steuerliche Auswirkung wählen',
});

/**
 * Feststellung, die bei der Gegenzeichnung einer Durchführung mit Befund
 * entsteht. „NEIN" ohne Würdigungsrecht wird im Service zu „UNKLAR" (TS-04).
 */
export const GegenzeichnungFeststellungSchema = z
  .object({
    titel: einzeilig(5, 200, 'Titel: mindestens 5 Zeichen'),
    sachverhalt: mitTextBasis(
      z.string().trim().min(20, 'Sachverhalt: mindestens 20 Zeichen').max(4000),
    ),
    klasse: FeststellungKlasseSchema,
    schwere: KlasseSchema,
    auswirkung: AuswirkungSchema,
    risikoIds: z
      .array(RisikoIdSchema)
      .min(1, 'mindestens ein betroffenes Risiko wählen')
      .max(50)
      .refine((r) => new Set(r).size === r.length, 'Risiko doppelt'),
  })
  .strict();

const gegenzeichnenFelder = { feststellung: GegenzeichnungFeststellungSchema.optional() };
export const GegenzeichnenBodySchema = z.object(gegenzeichnenFelder).strict();
export const GegenzeichnenEingabeSchema = z.object({ ...ziel, ...gegenzeichnenFelder }).strict();
export type GegenzeichnenEingabe = z.infer<typeof GegenzeichnenEingabeSchema>;

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

const Zeitpunkt = z.iso.datetime();
const Tag = z.iso.date();
const PersonId = z.string();

export const DurchfuehrungStatusSchema = z.enum([
  'GEPLANT',
  'IN_DURCHFUEHRUNG',
  'ZUR_GEGENZEICHNUNG',
  'ZURUECKGEWIESEN',
  'OHNE_BEFUND',
  'MIT_BEFUND',
  'ENTFALLEN',
]);
export const DurchfuehrungAnzeigeSchema = z.enum([
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

/**
 * Recht des Akteurs auf eine Handlung; gesperrte Bedienelemente zeigen `grund`
 * (AGENTS.md Regel 4). `verweigerung`: maschinenlesbarer Grund, wenn die Person
 * den Schritt nicht darf – derselbe Wert, den die Schreiboperation als
 * `fehler.grund` ihres `403` liefert (gleiche Rechtefunktion); `null`, wenn
 * erlaubt oder wenn nur der Zustand entgegensteht (die Operation antwortet
 * dann `409`). Erlaubt ⇒ weder `grund` noch `verweigerung`; verweigert ⇒
 * `grund` (Text) gesetzt.
 */
export const DurchfuehrungRechtSchema = z
  .object({
    erlaubt: z.boolean(),
    grund: z.string().nullable(),
    verweigerung: z.enum(VERWEIGERUNG_GRUENDE).nullable(),
  })
  .strict()
  .refine((r) => (r.erlaubt ? r.grund === null && r.verweigerung === null : r.grund !== null), {
    message: 'erlaubt ohne Grund, verweigert mit Grund',
    path: ['verweigerung'],
  });

export const DurchfuehrungRechteSchema = z
  .object({
    beginnen: DurchfuehrungRechtSchema,
    /** Schritte, Werte, Ergebnis, Nachweise, Einreichen (vor Beginn: impliziter Beginn). */
    bearbeiten: DurchfuehrungRechtSchema,
    gegenzeichnen: DurchfuehrungRechtSchema,
    mandantBestaetigen: DurchfuehrungRechtSchema,
    zurueckweisen: DurchfuehrungRechtSchema,
    entfallenBeantragen: DurchfuehrungRechtSchema,
    entfallenFreigeben: DurchfuehrungRechtSchema,
    entfallenAblehnen: DurchfuehrungRechtSchema,
    nachtrag: DurchfuehrungRechtSchema,
  })
  .strict();

export const NachweisSchema = z
  .object({
    id: z.string(),
    /** Dokument-ID der kanzleikonsole; Downloads laufen dort (ADR 0001 §6). */
    dokumentId: z.string(),
    dateiname: z.string(),
    mime: z.string(),
    groesse: z.number().int(),
    sha256: z.string(),
    gesperrt: z.boolean(),
    hochgeladenVon: PersonId,
    hochgeladenAm: Zeitpunkt,
  })
  .strict();

export const DurchfuehrungSchrittSchema = z
  .object({
    titel: z.string(),
    hinweis: z.string(),
    erledigt: z.boolean(),
    kommentar: z.string(),
  })
  .strict();

export const DurchfuehrungKennzahlSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    sollEur: z.number().nullable(),
    differenzAus: z.tuple([z.string(), z.string()]).optional(),
  })
  .strict();

export const DurchfuehrungWertSchema = z
  .object({
    key: z.string(),
    wert: z.number().nullable(),
    bemerkung: z.string(),
    erklaert: z.boolean(),
  })
  .strict();

/**
 * Kennzahl in der Prüfung: vom Dienst berechnete Werte, damit Kanzlei und
 * Portal dieselben Differenzen zeigen wie die Prüfung beim Einreichen (statt
 * sie selbst zu rechnen).
 */
export const KennzahlPruefungSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    /** Erfasster Wert bzw. berechnete Differenz (a − b aus `differenzAus`, auf Cent gerundet). */
    wert: z.number().nullable(),
    /** Abweichung gegen das Soll bzw. die Differenz selbst; null = keine Toleranzprüfung. */
    abweichung: z.number().nullable(),
    /** Lage zur Toleranz der Kontrolle (`AUSSERHALB` ohne Erklärung steht auch in `ausserhalb`). */
    lage: z.enum(['OK', 'ERKLAERT', 'AUSSERHALB']).nullable(),
    /** Differenzkennzahl (berechnet, nicht erfasst). */
    berechnet: z.boolean(),
  })
  .strict();

export const EinreichPruefungSchema = z
  .object({
    schritteErledigt: z.number().int(),
    schritteGesamt: z.number().int(),
    werteFehlend: z.array(z.string()),
    ausserhalb: z.array(z.string()),
    /** Je Kennzahl der Kontrolle die berechneten Werte (Reihenfolge der Kontrolle). */
    kennzahlen: z.array(KennzahlPruefungSchema),
    nachweise: z.number().int(),
    mindestNachweise: z.number().int(),
    ergebnis: DurchfuehrungErgebnisSchema.nullable(),
    kommentarFehlt: z.boolean(),
    maengel: z.array(z.string()),
  })
  .strict();

export const DurchfuehrungKurzSchema = z
  .object({ id: z.string(), periodeLabel: z.string(), anzeige: DurchfuehrungAnzeigeSchema })
  .strict();

export const DurchfuehrungVerlaufSchema = z
  .object({
    /** Position im Audit des Tenants (RT-03); abgeleitete Einträge („System") negativ. */
    pos: z.number().int(),
    at: Zeitpunkt,
    /** null bei abgeleiteten Einträgen („System"). */
    actorId: PersonId.nullable(),
    aktion: z.string(),
    text: z.string(),
    system: z.boolean(),
  })
  .strict();

export const DurchfuehrungPersonNameSchema = z.object({ id: PersonId, name: z.string() }).strict();

const kontrolleFelder = {
  id: z.string(),
  code: z.string(),
  standId: z.string(),
  version: z.number().int(),
  gueltigAb: Zeitpunkt,
  titel: z.string(),
  ziel: z.string(),
  art: z.enum(['P', 'D', 'K']),
  ausfuehrung: z.enum(['M', 'IT', 'A']),
  partei: z.enum(['KANZLEI', 'MANDANT']),
  schluessel: z.boolean(),
  nachweis: z.string(),
  mindestNachweise: z.number().int(),
  toleranzEur: z.number().nullable(),
  faelligNachTagen: z.number().int(),
  durchfuehrendId: PersonId.nullable(),
  vertretungId: PersonId.nullable(),
  gegenzeichnerId: PersonId.nullable(),
  gegenzeichnungMandant: z.boolean(),
  kennzahlen: z.array(DurchfuehrungKennzahlSchema),
};

/** Gemeinsame Felder von Kanzlei-Detail und Portal-Aufgabe. */
const aufgabeFelder = {
  id: z.string(),
  mandantId: z.string(),
  periodeLabel: z.string(),
  periodeVon: Tag,
  periodeBis: Tag,
  faelligAm: Tag,
  status: DurchfuehrungStatusSchema,
  /** Status zum Stichtag inkl. abgeleitet Fällig/Überfällig. */
  anzeige: DurchfuehrungAnzeigeSchema,
  ausserplanmaessig: z.boolean(),
  schritte: z.array(DurchfuehrungSchrittSchema),
  werte: z.array(DurchfuehrungWertSchema),
  ergebnis: DurchfuehrungErgebnisSchema.nullable(),
  ergebnisKommentar: z.string().nullable(),
  durchgefuehrtVon: PersonId.nullable(),
  begonnenAm: Zeitpunkt.nullable(),
  eingereichtAm: Zeitpunkt.nullable(),
  mandantBestaetigtVon: PersonId.nullable(),
  mandantBestaetigtAm: Zeitpunkt.nullable(),
  gegengezeichnetVon: PersonId.nullable(),
  abgeschlossenAm: Zeitpunkt.nullable(),
  zurueckgewiesenVon: PersonId.nullable(),
  zurueckgewiesenAm: Zeitpunkt.nullable(),
  zurueckweisungsgrund: z.string().nullable(),
  entfallenBegruendung: z.string().nullable(),
  entfallenAm: Zeitpunkt.nullable(),
  createdAt: Zeitpunkt,
  /** false, wenn die Durchführung zum Stichtag noch nicht existierte. */
  vorhandenZumStand: z.boolean(),
  nachweise: z.array(NachweisSchema),
  /** Nach dem Stichtag angehängte Nachweise (ausgeblendet). */
  nachweiseAusgeblendet: z.number().int(),
  original: z.object({ id: z.string(), periodeLabel: z.string() }).strict().nullable(),
  pruefung: EinreichPruefungSchema,
  rechte: DurchfuehrungRechteSchema,
  heute: Tag,
  stand: Tag,
  historisch: z.boolean(),
  namen: z.array(DurchfuehrungPersonNameSchema),
};

/** Kontrolldurchführung in der Kanzlei (S8). */
export const DurchfuehrungDetailSchema = z
  .object({
    ...aufgabeFelder,
    programmId: z.string(),
    kontrolle: z
      .object({
        ...kontrolleFelder,
        design: z.enum(['ANGEMESSEN', 'NICHT_BEURTEILT', 'MANGEL']),
        designVon: PersonId.nullable(),
        designAm: Zeitpunkt.nullable(),
      })
      .strict(),
    anlass: z.string().nullable(),
    entfallenVon: PersonId.nullable(),
    entfallenFreigegebenVon: PersonId.nullable(),
    nachtragZuId: z.string().nullable(),
    /**
     * Verknüpfte Feststellungen; vertrauliche für Nicht-Beteiligte maskiert
     * (`maskiert: true`: nur Nummer und Status, kein Titel, keine Schwere – RT-01).
     */
    feststellungen: z.array(
      z.discriminatedUnion('maskiert', [
        z
          .object({
            maskiert: z.literal(false),
            id: z.string(),
            nummer: z.string(),
            titel: z.string(),
            status: z.string(),
            schwere: KlasseSchema,
            vertraulich: z.boolean(),
          })
          .strict(),
        z
          .object({
            maskiert: z.literal(true),
            id: z.string(),
            nummer: z.string(),
            status: z.string(),
            vertraulich: z.literal(true),
          })
          .strict(),
      ]),
    ),
    risiken: z.array(z.object({ id: z.string(), code: z.string(), titel: z.string() }).strict()),
    letzte: z.array(DurchfuehrungKurzSchema),
    nachtraege: z.array(DurchfuehrungKurzSchema),
    verlauf: z.array(DurchfuehrungVerlaufSchema),
    /** Personen, die an der Durchführung mitgewirkt haben (dürfen nicht gegenzeichnen). */
    beteiligte: z.array(PersonId),
  })
  .strict();
export type DurchfuehrungDetail = z.infer<typeof DurchfuehrungDetailSchema>;

/** Kontrollaufgabe im Portal (P2): ohne Kanzlei-Interna (Verlauf, Feststellungen, Risiken). */
export const KontrollaufgabeSchema = z
  .object({ ...aufgabeFelder, kontrolle: z.object(kontrolleFelder).strict() })
  .strict();
export type Kontrollaufgabe = z.infer<typeof KontrollaufgabeSchema>;

export const KontrollaufgabenEintragSchema = z
  .object({
    id: z.string(),
    kontrolleCode: z.string(),
    titel: z.string(),
    periodeLabel: z.string(),
    periodeBis: Tag,
    faelligAm: Tag,
    status: DurchfuehrungStatusSchema,
    anzeige: DurchfuehrungAnzeigeSchema,
    /** DURCHFUEHREN: offene Aufgabe; BESTAETIGEN: Bestätigung durch eine zweite Person. */
    art: z.enum(['DURCHFUEHREN', 'BESTAETIGEN']),
    /** Akteur ist zugewiesen (Durchführung/Vertretung bzw. vorgesehene Bestätigung). */
    eigene: z.boolean(),
    durchfuehrendId: PersonId.nullable(),
    nachweise: z.number().int(),
    mindestNachweise: z.number().int(),
  })
  .strict();
export const KontrollaufgabenSchema = z
  .object({ aufgaben: z.array(KontrollaufgabenEintragSchema), heute: Tag })
  .strict();
export type Kontrollaufgaben = z.infer<typeof KontrollaufgabenSchema>;

export const NachweisErgebnisSchema = z
  .object({ durchfuehrungId: z.string(), nachweis: NachweisSchema })
  .strict();
export type NachweisErgebnis = z.infer<typeof NachweisErgebnisSchema>;

/** Ergebnis eines Zustandsübergangs. */
export const DurchfuehrungUebergangSchema = z
  .object({ durchfuehrungId: z.string(), status: DurchfuehrungStatusSchema })
  .strict();
export type DurchfuehrungUebergang = z.infer<typeof DurchfuehrungUebergangSchema>;

export const DurchfuehrungSpeichernErgebnisSchema = z
  .object({
    durchfuehrungId: z.string(),
    status: DurchfuehrungStatusSchema,
    /** Prüfung des gespeicherten Stands für das Einreichen. */
    pruefung: EinreichPruefungSchema,
  })
  .strict();
export type DurchfuehrungSpeichernErgebnis = z.infer<typeof DurchfuehrungSpeichernErgebnisSchema>;

export const NachweisEntferntSchema = z
  .object({ durchfuehrungId: z.string(), nachweisId: z.string() })
  .strict();
export type NachweisEntfernt = z.infer<typeof NachweisEntferntSchema>;

export const GegenzeichnenErgebnisSchema = z
  .object({
    durchfuehrungId: z.string(),
    status: z.enum(['OHNE_BEFUND', 'MIT_BEFUND']),
    feststellung: z.object({ id: z.string(), nummer: z.string() }).strict().nullable(),
  })
  .strict();
export type GegenzeichnenErgebnis = z.infer<typeof GegenzeichnenErgebnisSchema>;

export const NachtragErgebnisSchema = z
  .object({ durchfuehrungId: z.string(), nachtragZuId: z.string() })
  .strict();
export type NachtragErgebnis = z.infer<typeof NachtragErgebnisSchema>;
