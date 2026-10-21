// =============================================================================
// Vertrag (zod) des Bereichs „feststellungen-ereignisse" (Welle 2): Eingaben
// und Antworten für Feststellungen und Maßnahmen (S10), Ereigniseingang und
// Triage (S11), Portal-Meldung (P3) und Länder-Monitor (S12).
//
// Grundsätze (ADR 0001 §7, AGENTS.md):
//   - Alle Objekte sind strikt: unbekannte Felder → UNGUELTIG.
//   - Eingabe = Body + Pfadparameter. Die Route setzt `mandantId` und Objekt-IDs
//     aus dem Pfad nach dem Body ein; Body-Schemas kennen diese Felder nicht.
//   - Schreibende Eingaben haben keinen Stichtag (TS-07). `stand` gibt es nur
//     in Lesern (`StandSchema`).
//   - §-153-Würdigung: vier gleichrangige Optionen ohne Standardwert und ohne
//     Empfehlung (AGENTS.md Regel 5); die Entscheidung ist Pflichtfeld.
//   - Personen: nur IDs der kanzleikonsole. Wo ein Anzeigename fachlich in
//     einen Text eingeht (Benachrichtigung der Kanzlei), liefert ihn die
//     kanzleikonsole ausdrücklich mit; er begründet nie ein Recht.
//   - Antworten: Datumswerte als ISO-Strings (`YYYY-MM-DD` für Kalendertage,
//     ISO-8601 mit Zeit für Zeitpunkte), Listen statt Map/Set.
// =============================================================================

import { z } from 'zod';
import { VERWEIGERUNG_GRUENDE } from '../fehler';
import {
  BearbeitenRechteSchema,
  DATEINAME_GESPEICHERT_UNZULAESSIG,
  DATEINAME_UNZULAESSIG,
  einzeilig,
  freitext,
  StandSchema,
} from './lesepfade';

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

/** IDs von Tax-CMS-Objekten (cuid, Kleinbuchstaben und Ziffern). */
export const ObjektIdSchema = z.string().regex(/^[a-z0-9]{16,40}$/, 'Ungültige ID');

/** Kalendertag `YYYY-MM-DD` (nur gültige Tage). */
export const TagSchema = z.iso.date();

// Freitexte (`freitext`) und einzeilige Texte (`einzeilig`) kommen aus
// lesepfade.ts: eine Text-Basisregel für den ganzen Vertrag (RT4-T-08).

const iso = z.iso.datetime();

export const FeststellungStatusSchema = z.enum([
  'ERFASST',
  'IN_WUERDIGUNG',
  'MASSNAHMEN_OFFEN',
  'NACHKONTROLLE',
  'GESCHLOSSEN',
  'VERWORFEN',
]);
export const FeststellungQuelleSchema = z.enum([
  'KONTROLLE',
  'EREIGNIS',
  'STICHPROBE',
  'HINWEIS',
  'AUSSENPRUEFUNG',
]);
export const FeststellungKlasseSchema = z.enum([
  'DESIGNMANGEL',
  'DURCHFUEHRUNGSMANGEL',
  'STEUERLICHER_FEHLER',
  'HINWEIS',
]);
export const SchwereSchema = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']);
export const AuswirkungSchema = z.enum(['JA', 'NEIN', 'UNKLAR']);
/** Die vier gleichrangigen §-153-Optionen (keine Reihenfolge als Empfehlung, kein Standard). */
export const P153EntscheidungSchema = z.enum([
  'BERICHTIGUNG',
  'KEINE_PFLICHT',
  'WEITERE_KLAERUNG',
  'UEBERGABE',
]);
export const MassnahmeStatusSchema = z.enum(['OFFEN', 'ERLEDIGT']);
export const EreignisStatusSchema = z.enum(['NEU', 'IN_TRIAGE', 'ERLEDIGT', 'VERWORFEN']);
export const EreignisQuelleSchema = z.enum(['PORTAL', 'KONTROLLE', 'STAMMDATEN', 'RSS', 'MANUELL']);
export const FolgeArtSchema = z.enum([
  'RISIKO_NEU_BEWERTEN',
  'RISIKO_AKTIVIEREN',
  'KONTROLLE_AUSSERPLANMAESSIG',
  'PROFIL_AENDERN',
  'FESTSTELLUNG_ANLEGEN',
  'HINWEIS',
]);
export const FolgeStatusSchema = z.enum(['VORGESCHLAGEN', 'ANGELEGT', 'ERLEDIGT', 'VERWORFEN']);
export const AnzeigeStatusSchema = z.enum([
  'GEPLANT',
  'FAELLIG',
  'IN_DURCHFUEHRUNG',
  'ZUR_GEGENZEICHNUNG',
  'ZURUECKGEWIESEN',
  'UEBERFAELLIG',
  'OHNE_BEFUND',
  'MIT_BEFUND',
  'ENTFALLEN',
]);

/**
 * Person, der eine Aufgabe zugewiesen wird (Maßnahme, Folge). `art` sagt, ob
 * die ID ein Mitarbeiter (KANZLEI) oder ein Mandantenkontakt (MANDANT) der
 * kanzleikonsole ist; Mandantenkontakte prüft der Dienst gegen ihre aktive Rolle.
 */
export const PersonZuweisungSchema = z
  .object({ id: z.uuid(), art: z.enum(['KANZLEI', 'MANDANT']) })
  .strict();

/** Mandant im Pfad (UUID der kanzleikonsole). */
const mandant = { mandantId: z.uuid() };
const lesen = { ...mandant, stand: StandSchema.optional() };

/** Query der Leser: nur `?stand=YYYY-MM-DD`. */
export const StandQuerySchema = z.object({ stand: StandSchema.optional() }).strict();

/** Name-Wert-Paar für aufgelöste Anzeigenamen (im Dienst leer, ADR 0001 §5). */
export const NamenSchema = z.array(z.object({ id: z.string(), name: z.string() }).strict());

// ===========================================================================
// Feststellungen und Maßnahmen (S10)
// ===========================================================================

export const FeststellungenLesenSchema = z.object(lesen).strict();
export const FeststellungLesenSchema = z
  .object({ ...lesen, feststellungId: ObjektIdSchema })
  .strict();

const feststellung = { ...mandant, feststellungId: ObjektIdSchema };

// ---- Status weiterschalten ----
/**
 * Antworten: `409 KONFLIKT` nur, wenn der Status inzwischen ein anderer als
 * `von` ist (gleichzeitige Änderung, TS-05). Ist der Schritt auf dem
 * gesehenen Stand fachlich gesperrt (geschlossen/verworfen, kein weiterer
 * Schritt, §-153-Würdigung offen, Maßnahme fehlt oder offen, Nachkontrolle
 * fehlt), antwortet der Dienst `400 UNGUELTIG` mit `felder.von` (Grund als
 * Text); fehlendes Recht bleibt `403` (vor dem Zustand geprüft).
 */
export const FeststellungWeiterBodySchema = z
  .object({
    /** Status, den der Aufrufer gesehen hat; weicht er ab → KONFLIKT (TS-05). */
    von: FeststellungStatusSchema,
  })
  .strict();
export const FeststellungWeiterSchema = FeststellungWeiterBodySchema.extend(feststellung).strict();

// ---- §-153-Würdigung ----
export const P153BodySchema = z
  .object({
    /** Pflicht, ohne Standardwert (AGENTS.md Regel 5). */
    entscheidung: P153EntscheidungSchema,
    begruendung: freitext(30, 4000),
    /** Pflicht bei Berichtigung und weiterer Klärung; sonst ohne Wirkung. */
    frist: TagSchema.optional(),
    /** Bisherige Entscheidung, die der Aufrufer gesehen hat (null = keine); Abweichung → KONFLIKT. */
    bisher: P153EntscheidungSchema.nullable(),
  })
  .strict();
export const P153Schema = P153BodySchema.extend(feststellung).strict();

// ---- Würdigungsangaben ----
export const WuerdigungBodySchema = z
  .object({
    schwere: SchwereSchema,
    auswirkung: AuswirkungSchema,
    ursache: freitext(0, 2000).nullable().optional(),
  })
  .strict();
export const WuerdigungSchema = WuerdigungBodySchema.extend(feststellung).strict();

// ---- Betroffene Erklärung ----
/** Spalte DECIMAL(14,2): Beträge betragsmäßig unter 10^12. */
export const MAX_BETRAG_EUR = 999_999_999_999.99;
// Steuerart, Land und Zeitraum sind Bezeichnungen (Tabellenspalten, Audit):
// einzeilig wie Titel (tcms-s10). Gespeicherte Erklärungen liest der Vertrag
// weiter ohne Zeichenregel (Altbestand, `FeststellungDetailSchema`).
export const ErklaerungBodySchema = z
  .object({
    steuerart: einzeilig(2, 120),
    land: einzeilig(2, 40),
    zeitraum: einzeilig(2, 40),
    /** Geschätzte Auswirkung in EUR; null = noch zu klären. */
    auswirkungEur: z.number().min(-MAX_BETRAG_EUR).max(MAX_BETRAG_EUR).nullable().optional(),
  })
  .strict();
export const ErklaerungSchema = ErklaerungBodySchema.extend(feststellung).strict();

// ---- Maßnahme anlegen / erledigen ----
export const MassnahmeBodySchema = z
  .object({
    beschreibung: freitext(5, 500),
    verantwortlich: PersonZuweisungSchema,
    frist: TagSchema,
  })
  .strict();
export const MassnahmeSchema = MassnahmeBodySchema.extend(feststellung).strict();

export const MassnahmeErledigenBodySchema = z.object({ nachweis: freitext(10, 2000) }).strict();
export const MassnahmeErledigenSchema = MassnahmeErledigenBodySchema.extend({
  ...mandant,
  massnahmeId: ObjektIdSchema,
}).strict();
/** Pfadparameter von `massnahmen/{id}/erledigen` (Endpunktregister). */
export const MassnahmeAktionSchema = z.object({ ...mandant, massnahmeId: ObjektIdSchema }).strict();

// ---- Nachkontrolle ----
export const NachkontrolleBodySchema = z
  .object({ kontrolleId: ObjektIdSchema, faelligAm: TagSchema })
  .strict();
export const NachkontrolleSchema = NachkontrolleBodySchema.extend(feststellung).strict();

// ---- Verwerfen (Vier-Augen) ----
export const VerwerfenBeantragenBodySchema = z.object({ begruendung: freitext(30, 2000) }).strict();
export const FeststellungVerwerfenBeantragenSchema =
  VerwerfenBeantragenBodySchema.extend(feststellung).strict();
/** Bestätigen, Ablehnen: nur Pfadparameter. */
export const FeststellungAktionSchema = z.object(feststellung).strict();

// ---- Vertraulich ----
export const VertraulichBodySchema = z.object({ vertraulich: z.boolean() }).strict();
export const VertraulichSchema = VertraulichBodySchema.extend(feststellung).strict();

// ---- Feststellung erfassen ----
export const FeststellungErfassenBodySchema = z
  .object({
    titel: einzeilig(5, 200),
    sachverhalt: freitext(20, 4000),
    quelle: FeststellungQuelleSchema,
    /** Angabe zur Quelle (Bezeichnung, z. B. „Außenprüfung USt 2024“): einzeilig (tcms-s10). */
    quelleText: einzeilig(2, 200),
    /** Nur bei Quelle KONTROLLE: Durchführung desselben Programms. */
    durchfuehrungId: ObjektIdSchema.optional(),
    klasse: FeststellungKlasseSchema,
    schwere: SchwereSchema,
    /** „NEIN" wirkt nur mit Würdigungsrecht, sonst entsteht „UNKLAR" (TS-04). */
    auswirkung: AuswirkungSchema,
    risikoIds: z
      .array(ObjektIdSchema)
      .max(100)
      .refine((l) => new Set(l).size === l.length, 'Risiken doppelt angegeben')
      .optional(),
  })
  .strict();
export const FeststellungErfassenSchema = FeststellungErfassenBodySchema.extend(mandant).strict();

// ---- Antworten ----
export const MassnahmeZeileSchema = z
  .object({
    id: z.string(),
    feststellungId: z.string(),
    wiedervorlageNr: z.number().int(),
    beschreibung: z.string(),
    verantwortlich: z.string(),
    frist: TagSchema,
    /** Status zum Stichtag. */
    status: MassnahmeStatusSchema,
    erledigtAm: iso.nullable(),
    erledigtVon: z.string().nullable(),
    createdAt: iso,
  })
  .strict();

/** Maßnahme einer vertraulichen Feststellung für Nicht-Beteiligte (Wiedervorlage ohne Inhalt). */
export const MassnahmeMaskiertSchema = MassnahmeZeileSchema.pick({
  id: true,
  feststellungId: true,
  wiedervorlageNr: true,
  frist: true,
  status: true,
}).strict();

const P153StandSchema = z
  .object({
    entscheidung: P153EntscheidungSchema,
    begruendung: z.string().nullable(),
    frist: TagSchema.nullable(),
    von: z.string().nullable(),
    am: iso,
  })
  .strict();

export const FeststellungListenEintragSchema = z.discriminatedUnion('maskiert', [
  z
    .object({
      maskiert: z.literal(false),
      id: z.string(),
      nummer: z.string(),
      titel: z.string(),
      quelle: FeststellungQuelleSchema,
      quelleText: z.string(),
      klasse: FeststellungKlasseSchema,
      schwere: SchwereSchema,
      auswirkung: AuswirkungSchema,
      /** Status zum Stichtag. */
      status: FeststellungStatusSchema,
      vertraulich: z.boolean(),
      erfasstVon: z.string(),
      erfasstAm: iso,
      durchfuehrungId: z.string().nullable(),
      ereignisId: z.string().nullable(),
      p153: P153StandSchema.nullable(),
      p153Offen: z.boolean(),
      verwerfenOffen: z.boolean(),
      massnahmenOffen: z.number().int(),
      massnahmenGesamt: z.number().int(),
      aeltesteFrist: TagSchema.nullable(),
      risikoCodes: z.array(z.string()),
      massnahmen: z.array(MassnahmeZeileSchema),
    })
    .strict(),
  z
    .object({
      /** Vertrauliche Feststellung, Akteur nicht beteiligt (Fachkonzept §13). */
      maskiert: z.literal(true),
      id: z.string(),
      nummer: z.string(),
      vertraulich: z.literal(true),
      status: FeststellungStatusSchema,
      erfasstAm: iso,
      massnahmen: z.array(MassnahmeMaskiertSchema),
    })
    .strict(),
]);

export const FeststellungListeSchema = z
  .object({
    stand: TagSchema,
    historisch: z.boolean(),
    programmId: z.string().nullable(),
    feststellungen: z.array(FeststellungListenEintragSchema),
    namen: NamenSchema,
  })
  .strict();

/** Verlaufseintrag; `pos` ist die Position im Audit des Tenants (RT-03). */
export const VerlaufEintragSchema = z
  .object({ pos: z.number().int(), at: iso, actorId: z.string().nullable(), text: z.string() })
  .strict();

export const FeststellungDetailSchema = z.discriminatedUnion('maskiert', [
  z
    .object({
      maskiert: z.literal(false),
      stand: TagSchema,
      historisch: z.boolean(),
      id: z.string(),
      programmId: z.string(),
      nummer: z.string(),
      titel: z.string(),
      sachverhalt: z.string(),
      quelle: FeststellungQuelleSchema,
      quelleText: z.string(),
      klasse: FeststellungKlasseSchema,
      schwere: SchwereSchema,
      auswirkung: AuswirkungSchema,
      ursache: z.string().nullable(),
      status: FeststellungStatusSchema,
      /** Vertraulich zum Stichtag. */
      vertraulich: z.boolean(),
      /** Vertraulich heute (unabhängig vom Stichtag). */
      vertraulichAktuell: z.boolean(),
      p153: P153StandSchema.nullable(),
      durchfuehrung: z
        .object({
          id: z.string(),
          kontrolleId: z.string(),
          code: z.string(),
          periodeLabel: z.string(),
        })
        .strict()
        .nullable(),
      ereignis: z
        .object({ id: z.string(), nummer: z.string(), typ: z.string(), titel: z.string() })
        .strict()
        .nullable(),
      nachkontrolle: z
        .object({
          id: z.string(),
          kontrolleId: z.string(),
          code: z.string(),
          titel: z.string(),
          periodeLabel: z.string(),
          faelligAm: TagSchema,
          anzeige: AnzeigeStatusSchema,
          ausserplanmaessig: z.boolean(),
        })
        .strict()
        .nullable(),
      verwerfen: z
        .object({
          begruendung: z.string(),
          beantragtVon: z.string(),
          bestaetigtVon: z.string().nullable(),
        })
        .strict()
        .nullable(),
      erfasstVon: z.string(),
      erfasstAm: iso,
      geschlossenAm: iso.nullable(),
      risiken: z.array(z.object({ id: z.string(), code: z.string() }).strict()),
      erklaerungen: z.array(
        z
          .object({
            id: z.string(),
            steuerart: z.string(),
            land: z.string(),
            zeitraum: z.string(),
            auswirkungEur: z.number().nullable(),
          })
          .strict(),
      ),
      massnahmen: z.array(
        MassnahmeZeileSchema.extend({ nachweis: z.string().nullable() }).strict(),
      ),
      verlauf: z.array(VerlaufEintragSchema),
      namen: NamenSchema,
    })
    .strict(),
  z
    .object({
      maskiert: z.literal(true),
      stand: TagSchema,
      historisch: z.boolean(),
      id: z.string(),
      nummer: z.string(),
      vertraulich: z.literal(true),
    })
    .strict(),
]);

export const FeststellungErgebnisSchema = z
  .object({ id: z.string(), nummer: z.string(), status: FeststellungStatusSchema })
  .strict();
export const FeststellungErfasstSchema = z
  .object({
    id: z.string(),
    nummer: z.string(),
    auswirkung: AuswirkungSchema,
    /** „NEIN" angegeben, aber ohne Würdigungsrecht als „UNKLAR" angelegt (TS-04). */
    auswirkungHerabgestuft: z.boolean(),
  })
  .strict();
export const P153ErgebnisSchema = z
  .object({
    id: z.string(),
    entscheidung: P153EntscheidungSchema,
    wiedervorlageNr: z.number().int().nullable(),
  })
  .strict();
export const ErklaerungErgebnisSchema = z
  .object({ id: z.string(), feststellungId: z.string() })
  .strict();
export const MassnahmeErgebnisSchema = z
  .object({ id: z.string(), wiedervorlageNr: z.number().int() })
  .strict();
export const NachkontrolleErgebnisSchema = z
  .object({ durchfuehrungId: z.string(), kontrolleCode: z.string() })
  .strict();
export const VertraulichErgebnisSchema = z
  .object({ id: z.string(), vertraulich: z.boolean(), geaendert: z.boolean() })
  .strict();
export const VerwerfenAbgelehntSchema = z
  .object({ id: z.string(), zurueckgezogen: z.boolean() })
  .strict();

// ===========================================================================
// Ereignisse (S11) und Portal-Meldung (P3)
// ===========================================================================

export const EreignisseLesenSchema = z.object(lesen).strict();
export const EreignisLesenSchema = z.object({ ...lesen, ereignisId: ObjektIdSchema }).strict();

const ereignis = { ...mandant, ereignisId: ObjektIdSchema };
const folge = { ...ereignis, folgeId: ObjektIdSchema };

/** Ereignistyp-Code (`T-01` … oder `SONST`); der Dienst prüft gegen den Katalog. */
export const EreignistypCodeSchema = z.string().regex(/^(T-\d{2}|SONST)$/);

export const EreignisAktionSchema = z.object(ereignis).strict();

// ---- Folgen anlegen (Auswahl der Vorschläge) ----
export const FolgeAnlegenSchema = z
  .object({
    folgeId: ObjektIdSchema,
    zustaendig: PersonZuweisungSchema.nullable().optional(),
    /** Pflicht bei außerplanmäßiger Kontrolle (Fälligkeit). */
    frist: TagSchema.nullable().optional(),
    /** Pflicht bei „Feststellung anlegen". „NEIN" nur mit Würdigungsrecht (TS-04). */
    feststellung: z
      .object({
        titel: einzeilig(5, 200),
        klasse: FeststellungKlasseSchema,
        schwere: SchwereSchema,
        auswirkung: AuswirkungSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export const FolgenAnlegenBodySchema = z
  .object({
    folgen: z
      .array(FolgeAnlegenSchema)
      .min(1)
      .max(50)
      .refine((l) => new Set(l.map((f) => f.folgeId)).size === l.length, 'Folge doppelt gewählt'),
  })
  .strict();
export const FolgenAnlegenSchema = FolgenAnlegenBodySchema.extend(ereignis).strict();

// ---- Weitere Folge vorschlagen ----
export const FolgeHinzufuegenBodySchema = z
  .object({
    art: FolgeArtSchema,
    /** Risikocode (EC-XXX-nn) bzw. Kontrollcode (K-EC-nn), je nach Art Pflicht. */
    ziel: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^(EC-[A-Z]{3}-\d{2}|K-EC-\d{2})$/)
      .nullable()
      .optional(),
    text: freitext(5, 300),
  })
  .strict();
export const FolgeHinzufuegenSchema = FolgeHinzufuegenBodySchema.extend(ereignis).strict();

// ---- Folge erledigen / verwerfen ----
export const FolgeAktionSchema = z.object(folge).strict();
export const FolgeVerwerfenSchema = VerwerfenBeantragenBodySchema.extend(folge).strict();

// ---- Verwerfen des Ereignisses (Vier-Augen) ----
export const EreignisVerwerfenBeantragenSchema =
  VerwerfenBeantragenBodySchema.extend(ereignis).strict();

// ---- Ereignis erfassen (Kanzlei) ----
export const EreignisErfassenBodySchema = z
  .object({
    typ: EreignistypCodeSchema,
    quelle: z.enum(['MANUELL', 'KONTROLLE', 'STAMMDATEN', 'RSS']),
    titel: einzeilig(5, 200),
    beschreibung: freitext(10, 4000),
    datum: TagSchema,
  })
  .strict();
export const EreignisErfassenSchema = EreignisErfassenBodySchema.extend(mandant).strict();

// ---- Anlage einer Meldung (Verweis, ADR 0001 §6) ----
/** Im Portal zulässige Dateitypen (PDF, Bild, CSV/Text, Excel, Word, ZIP). */
export const PORTAL_ANLAGE_MIME =
  /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/(csv|plain)|application\/(vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|vnd\.ms-excel|msword|zip))$/;
export const PORTAL_MAX_ANLAGEN = 5;
export const PORTAL_MAX_ANLAGE_BYTES = 10 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
// Wie `pruefeVerweis` (@tcms/service) und Nachweise: eine Regel für Dateinamen
// (Steuer-, Richtungs-, Nullbreiten- und Füllzeichen, Pfadtrenner; lesepfade.ts).
const DATEINAME_VERBOTEN = DATEINAME_UNZULAESSIG;

export const Sha256Schema = z.string().regex(SHA256, 'Ungültiger SHA-256');

/** Dateiname einer Anlage; `verboten` ist die Zeichenregel (neu bzw. gespeichert). */
const anlageDateiname = (verboten: RegExp) =>
  z
    .string()
    .min(1)
    .max(255)
    .refine((s) => s.trim().length > 0 && s !== '.' && s !== '..', 'Ungültiger Dateiname')
    .refine((s) => !verboten.test(s), 'Ungültiger Dateiname');

/**
 * Verweis auf eine Anlage, die die kanzleikonsole angenommen hat (Virenscan,
 * Journal). `dokumentId` ist für das Tax-CMS undurchsichtig; die Demo legt
 * dort ihren relativen Ablagepfad `<2 Hex>/<SHA-256>` ab, daher ist `/`
 * erlaubt, aber weder am Anfang noch als `.`/`..`-Segment.
 */
export const AnlageVerweisSchema = z
  .object({
    dokumentId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/)
      .refine((s) => !s.split('/').some((t) => t === '.' || t === '..'), 'Ungültige Dokument-ID'),
    dateiname: anlageDateiname(DATEINAME_VERBOTEN),
    mime: z.string().max(127).regex(PORTAL_ANLAGE_MIME, 'Dateityp nicht zulässig'),
    groesse: z.number().int().min(1).max(PORTAL_MAX_ANLAGE_BYTES),
    sha256: Sha256Schema,
  })
  .strict();

/**
 * Gespeicherter Anlage-Verweis in Antworten (`ereignisAnlageLesen`, im Detail
 * ohne Dokument-ID): wie `AnlageVerweisSchema`, der Dateiname aber nach der
 * Regel für gespeicherte Namen (`DATEINAME_GESPEICHERT_UNZULAESSIG`). Anlagen
 * stehen im unveränderlichen Meldungs-Audit; vor der Angleichung gespeicherte
 * Namen bleiben so lesbar. Neue Verweise prüft `AnlageVerweisSchema`.
 */
export const AnlageGespeichertSchema = AnlageVerweisSchema.extend({
  dateiname: anlageDateiname(DATEINAME_GESPEICHERT_UNZULAESSIG),
}).strict();

// ---- Portal: Ereignis melden ----
export const PortalMeldungBodySchema = z
  .object({
    typ: EreignistypCodeSchema,
    titel: einzeilig(5, 200),
    beschreibung: freitext(10, 4000),
    datum: TagSchema,
    anlagen: z
      .array(AnlageVerweisSchema)
      .max(PORTAL_MAX_ANLAGEN)
      .refine((l) => new Set(l.map((a) => a.sha256)).size === l.length, 'Anlage doppelt'),
    /** Zusage, Änderungen künftig zu melden (Kontrollkästchen P3). */
    zusageAenderungen: z.boolean(),
    /**
     * Wen die Kanzlei benachrichtigen soll (Zuständigkeit der kanzleikonsole,
     * nur für den Postausgang; begründet kein Recht).
     */
    benachrichtigen: z
      .object({ id: z.uuid(), name: einzeilig(1, 200) })
      .strict()
      .nullable()
      .optional(),
    /**
     * Idempotenzschlüssel der kanzleikonsole (UUID, je Meldung neu, tcms-s10):
     * Dieselbe Person meldet beim selben Mandanten mit demselben Schlüssel
     * innerhalb von 24 h genau ein Ereignis. Eine Wiederholung mit gleichem
     * Inhalt liefert dieselbe Antwort (`201`, dasselbe Ereignis, kein neues
     * Audit), ein anderer Inhalt `409` mit `konflikt: IDEMPOTENZ_ABWEICHUNG`.
     * Nach 24 h gilt der Schlüssel als verbraucht (neue Meldung).
     */
    idempotenzSchluessel: z.uuid().optional(),
  })
  .strict();
export const PortalMeldungSchema = PortalMeldungBodySchema.extend(mandant).strict();
export const PortalMeldungenLesenSchema = z.object(mandant).strict();

export const EreignisAnlageLesenSchema = z.object({ ...ereignis, sha256: Sha256Schema }).strict();

// ---- Ereignis-Anlagen je Dokument (Abgleich der kanzleikonsole, tcms-s11) ----
/**
 * Dokument-ID der kanzleikonsole (UUID), kanonisch in Kleinbuchstaben. Nur
 * UUIDs: Andere Formen, die eine Meldung tragen kann (Ablagepfade der Demo),
 * sind hier nicht abfragbar (`400`) – eine Freigabe ohne bestätigte Antwort
 * bleibt so aus (fail closed).
 */
const AnlageDokumentIdSchema = z.uuid().transform((s) => s.toLowerCase());

/**
 * Ereignis-Anlagen je Dokument (`GET …/ereignis-anlagen?dokumentId=`):
 * Gegenstück zu „Nachweise je Dokument“ (ADR 0001 §6). Nur Kanzleipersonen mit
 * Leserecht. `dokumentId` ist Pflicht (der Dienst antwortet sonst `400`); im
 * Query-Schema optional, weil das Register jede Query ohne Parameter zulässt
 * und die Pflicht im Service prüft.
 */
export const EreignisAnlagenJeDokumentQuerySchema = z
  .object({ dokumentId: AnlageDokumentIdSchema.optional() })
  .strict();
export const EreignisAnlagenJeDokumentPfadSchema = z.object(mandant).strict();
export const EreignisAnlagenJeDokumentEingabeSchema = z
  .object({ ...mandant, dokumentId: AnlageDokumentIdSchema })
  .strict();
/** Eingabe aus Pfad und Query (Pflicht von `dokumentId` prüft der Dienst mit dem Eingabeschema). */
export type EreignisAnlagenJeDokumentEingabe = z.input<typeof EreignisAnlagenJeDokumentPfadSchema> &
  z.input<typeof EreignisAnlagenJeDokumentQuerySchema>;

// ---- Antworten ----
export const EreignisListenEintragSchema = z
  .object({
    id: z.string(),
    nummer: z.string(),
    typ: z.string(),
    titel: z.string(),
    beschreibung: z.string(),
    quelle: EreignisQuelleSchema,
    gemeldetVon: z.string().nullable(),
    gemeldetAm: iso,
    ereignisDatum: TagSchema,
    /** Status zum Stichtag. */
    status: EreignisStatusSchema,
    verwerfenBeantragt: z.boolean(),
    triagiertVon: z.string().nullable(),
    triagiertAm: iso.nullable(),
    folgen: z.array(
      z
        .object({
          id: z.string(),
          art: FolgeArtSchema,
          ziel: z.string().nullable(),
          status: FolgeStatusSchema,
          objektId: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const EreignisListeSchema = z
  .object({
    stand: TagSchema,
    historisch: z.boolean(),
    programmId: z.string().nullable(),
    ereignisse: z.array(EreignisListenEintragSchema),
    namen: NamenSchema,
  })
  .strict();

export const AnlageSchema = AnlageGespeichertSchema.omit({ dokumentId: true }).strict();

export const FolgeDetailSchema = z
  .object({
    id: z.string(),
    art: FolgeArtSchema,
    ziel: z.string().nullable(),
    text: z.string(),
    zustaendig: z.string().nullable(),
    frist: TagSchema.nullable(),
    /** Status zum Stichtag. */
    status: FolgeStatusSchema,
    erledigtAm: iso.nullable(),
    objektId: z.string().nullable(),
    durchfuehrung: z
      .object({
        id: z.string(),
        code: z.string(),
        periodeLabel: z.string(),
        faelligAm: TagSchema,
        anzeige: AnzeigeStatusSchema,
      })
      .strict()
      .nullable(),
    feststellung: z.object({ id: z.string(), nummer: z.string() }).strict().nullable(),
    verwerfen: z
      .object({ begruendung: z.string(), vonId: z.string().nullable(), am: iso })
      .strict()
      .nullable(),
    angelegt: z.object({ vonId: z.string().nullable(), am: iso }).strict().nullable(),
  })
  .strict();

/**
 * Recht des Akteurs auf einen Schritt am Ereignis (wie die Rechte der
 * Durchführung): `verweigerung` ist der Grund des `403`, den die Operation
 * jetzt liefern würde (gleiche Vorbedingung im Dienst); `null` bei Erlaubnis
 * oder wenn nur der Zustand entgegensteht (die Operation antwortet `409`).
 * Im historischen Stand nie erlaubt.
 */
export const EreignisRechtSchema = z
  .object({
    erlaubt: z.boolean(),
    verweigerung: z.enum(VERWEIGERUNG_GRUENDE).nullable(),
  })
  .strict()
  .refine((r) => !r.erlaubt || r.verweigerung === null, {
    message: 'erlaubt ohne Verweigerungsgrund',
    path: ['verweigerung'],
  });

export const EreignisDetailSchema = EreignisListenEintragSchema.omit({ folgen: true })
  .extend({
    stand: TagSchema,
    historisch: z.boolean(),
    rechte: z
      .object({
        abschliessen: EreignisRechtSchema,
        verwerfen: z
          .object({ beantragen: EreignisRechtSchema, bestaetigen: EreignisRechtSchema })
          .strict(),
      })
      .strict(),
    folgen: z.array(FolgeDetailSchema),
    anlagen: z.array(AnlageSchema),
    meldung: z.object({ aktion: z.string(), at: iso, hash: z.string() }).strict().nullable(),
    verwerfenAntrag: z
      .object({ vonId: z.string().nullable(), am: iso, begruendung: z.string() })
      .strict()
      .nullable(),
    verwerfen: z
      .object({ vonId: z.string().nullable(), am: iso, begruendung: z.string() })
      .strict()
      .nullable(),
    verlauf: z.array(VerlaufEintragSchema),
    namen: NamenSchema,
  })
  .strict();

export const EreignisErgebnisSchema = z
  .object({ id: z.string(), nummer: z.string(), status: EreignisStatusSchema })
  .strict();
export const EreignisErfasstSchema = z
  .object({ id: z.string(), nummer: z.string(), folgen: z.number().int() })
  .strict();
export const FolgenAngelegtSchema = z
  .object({
    ereignisId: z.string(),
    folgen: z.array(
      z
        .object({
          folgeId: z.string(),
          status: FolgeStatusSchema,
          objektId: z.string().nullable(),
          /** Nummer der Feststellung bzw. Code der Kontrolle, sofern angelegt. */
          objekt: z.string().nullable(),
          auswirkungHerabgestuft: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export const FolgeErgebnisSchema = z.object({ id: z.string(), status: FolgeStatusSchema }).strict();
export const AnlageVerweisErgebnisSchema = AnlageGespeichertSchema;

/**
 * Jede Anlage einer Meldung eines Ereignisses dieses Mandanten, die die
 * Dokument-ID nennt (Vergleich ohne Groß-/Kleinschreibung), auch an
 * verworfenen Ereignissen. Eine leere Liste heißt: Kein Ereignis dieses
 * Mandanten referenziert die Dokument-ID – nur dann darf die kanzleikonsole
 * eine „ungeklärte Anlage“ freigeben. Eine Dokument-ID eines anderen Mandanten
 * oder eine unbekannte ergibt dieselbe leere Liste (kein Existenz-Orakel).
 *
 * Ereignisse kennen keine Vertraulichkeit (RT-01 gilt für Feststellungen, ADR
 * 0001 §10.2); ausgegeben werden nur ID, Nummer und Status des Ereignisses
 * (wie die Ereignisliste) und der SHA-256 der Anlage (wie das Detail) – keine
 * Titel, Beschreibungen, Dateinamen, Personen und nichts aus Feststellungen,
 * die aus dem Ereignis entstanden. `entfernt`: Anlagen einer Meldung stehen im
 * unveränderlichen Meldungs-Audit und lassen sich nicht entfernen; derzeit
 * immer `false`.
 */
export const EreignisAnlagenJeDokumentSchema = z
  .object({
    dokumentId: z.string(),
    anlagen: z.array(
      z
        .object({
          ereignisId: z.string(),
          nummer: z.string(),
          /** Aktueller Status des Ereignisses (auch `VERWORFEN`). */
          status: EreignisStatusSchema,
          sha256: Sha256Schema,
          entfernt: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export const PortalMeldungErgebnisSchema = z
  .object({ id: z.string(), nummer: z.string() })
  .strict();
export const PortalMeldungenSchema = z
  .object({
    /**
     * Melderecht des Akteurs (gesetzliche Vertretung oder Tax-Compliance-
     * Beauftragte:r mit aktiver Rolle) – dieselbe Regel wie `POST …/portal/ereignisse`.
     */
    melden: z.boolean(),
    /** Für den Mandanten besteht ein Tax-CMS (sonst nimmt das Melden nichts an). */
    programmVorhanden: z.boolean(),
    meldungen: z.array(
      z
        .object({
          id: z.string(),
          nummer: z.string(),
          typ: z.string(),
          titel: z.string(),
          status: EreignisStatusSchema,
          gemeldetAm: iso,
          gemeldetVon: z.string().nullable(),
        })
        .strict(),
    ),
    namen: NamenSchema,
  })
  .strict();

// ===========================================================================
// Länder-Monitor (S12)
// ===========================================================================

/** Spalte DECIMAL(14,2), fachliche Obergrenze wie bisher (100 Mrd. EUR). */
export const MAX_LAND_EUR = 100_000_000_000;
export const LandCodeSchema = z.string().regex(/^[A-Z]{2}$/);

export const LandEingabeSchema = z
  .object({
    land: LandCodeSchema,
    fernverkaeufeLfdEur: z.number().min(0).max(MAX_LAND_EUR),
    fernverkaeufeVorjahrEur: z.number().min(0).max(MAX_LAND_EUR),
    /** Monat `YYYY-MM`, ab dem ein Lager besteht. */
    lagerSeit: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .nullable(),
    oss: z.boolean(),
    lokaleUstNr: z.boolean(),
    zmRelevant: z.boolean(),
    steuersaetzeGeprueftAm: TagSchema.nullable(),
  })
  .strict();

export const LaenderLesenSchema = z.object(lesen).strict();

/**
 * Neue Länderstände (Historie bleibt). `datenstand` ist das fachliche Datum der
 * erfassten Werte (nicht nach heute), kein Lese-Stichtag (TS-07).
 */
export const LandStaendeBodySchema = z
  .object({
    datenstand: TagSchema,
    laender: z
      .array(LandEingabeSchema)
      .min(1)
      .max(40)
      .refine((l) => new Set(l.map((x) => x.land)).size === l.length, 'Land doppelt angegeben'),
  })
  .strict();
export const LandStaendeSchema = LandStaendeBodySchema.extend(mandant).strict();

export const LandHinzufuegenBodySchema = z
  .object({ datenstand: TagSchema, land: LandEingabeSchema })
  .strict();
export const LandHinzufuegenSchema = LandHinzufuegenBodySchema.extend(mandant).strict();

export const LandStandSchema = z
  .object({
    id: z.string(),
    land: z.string(),
    fernverkaeufeLfdEur: z.number(),
    fernverkaeufeVorjahrEur: z.number(),
    lagerSeit: z.string().nullable(),
    oss: z.boolean(),
    lokaleUstNr: z.boolean(),
    zmRelevant: z.boolean(),
    steuersaetzeGeprueftAm: TagSchema.nullable(),
    stand: TagSchema,
    quelle: z.enum(['MANUELL', 'CSV']),
    erfasstVon: z.string().nullable(),
    createdAt: iso,
    registrierung: z.enum(['VOLLSTAENDIG', 'FEHLT', 'PRUEFEN']),
  })
  .strict();

export const LaenderSchema = z
  .object({
    stand: TagSchema,
    historisch: z.boolean(),
    programmId: z.string().nullable(),
    /** Länder aufnehmen und Stände erfassen: wie die Schreiboperationen (`kannBearbeiten`). */
    rechte: BearbeitenRechteSchema,
    /** Stände je Land bis zum Stichtag, neueste zuerst. */
    historie: z.array(z.object({ land: z.string(), staende: z.array(LandStandSchema) }).strict()),
    /**
     * Feststellungen mit Länderbezug; vertrauliche nur für die Kanzleileitung
     * (Admins/Partner, tcms-s12), für alle anderen nie (RT-01).
     */
    feststellungen: z.array(
      z
        .object({
          land: z.string(),
          eintraege: z.array(
            z
              .object({
                id: z.string(),
                nummer: z.string(),
                titel: z.string(),
                status: FeststellungStatusSchema,
                p153Offen: z.boolean(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    /**
     * Bezüge je Land im Monitor (jüngster Stand bis zum Stichtag), deterministisch
     * aus seinen Merkmalen: aktive Risiken mit Länderbezug (Katalogcode und Grund),
     * Codes der aktiven Kontrollen an diesen Risiken, IDs der Ereignisse bis zum
     * Stichtag, die das Land (Code oder Name) in Titel oder Beschreibung nennen.
     * Feststellungen gehen nicht ein (vertrauliche nie, RT-01).
     */
    bezuege: z.array(
      z
        .object({
          land: z.string(),
          risiken: z.array(z.object({ code: z.string(), grund: z.string() }).strict()),
          kontrollen: z.array(z.string()),
          ereignisse: z.array(z.string()),
        })
        .strict(),
    ),
    namen: NamenSchema,
  })
  .strict();

export const LandStaendeErgebnisSchema = z
  .object({
    staende: z.array(z.object({ id: z.string(), land: z.string() }).strict()),
    /** Nummern der ausgelösten Ereignisse (T-02 neues Lagerland, T-04 Schwellenwechsel). */
    ereignisse: z.array(z.string()),
  })
  .strict();

// ===========================================================================
// Typen
// ===========================================================================

export type FeststellungenLesen = z.infer<typeof FeststellungenLesenSchema>;
export type FeststellungLesen = z.infer<typeof FeststellungLesenSchema>;
export type FeststellungWeiter = z.infer<typeof FeststellungWeiterSchema>;
export type P153Eingabe = z.infer<typeof P153Schema>;
export type WuerdigungEingabe = z.infer<typeof WuerdigungSchema>;
export type ErklaerungEingabe = z.infer<typeof ErklaerungSchema>;
export type MassnahmeEingabe = z.infer<typeof MassnahmeSchema>;
export type MassnahmeErledigenEingabe = z.infer<typeof MassnahmeErledigenSchema>;
export type NachkontrolleEingabe = z.infer<typeof NachkontrolleSchema>;
export type FeststellungVerwerfenBeantragen = z.infer<typeof FeststellungVerwerfenBeantragenSchema>;
export type FeststellungAktion = z.infer<typeof FeststellungAktionSchema>;
export type VertraulichEingabe = z.infer<typeof VertraulichSchema>;
export type FeststellungErfassen = z.infer<typeof FeststellungErfassenSchema>;
export type PersonZuweisung = z.infer<typeof PersonZuweisungSchema>;

export type MassnahmeZeile = z.infer<typeof MassnahmeZeileSchema>;
export type FeststellungListenEintrag = z.infer<typeof FeststellungListenEintragSchema>;
export type FeststellungListe = z.infer<typeof FeststellungListeSchema>;
export type FeststellungDetail = z.infer<typeof FeststellungDetailSchema>;
export type FeststellungErgebnis = z.infer<typeof FeststellungErgebnisSchema>;
export type FeststellungErfasst = z.infer<typeof FeststellungErfasstSchema>;
export type P153Ergebnis = z.infer<typeof P153ErgebnisSchema>;
export type ErklaerungErgebnis = z.infer<typeof ErklaerungErgebnisSchema>;
export type MassnahmeErgebnis = z.infer<typeof MassnahmeErgebnisSchema>;
export type NachkontrolleErgebnis = z.infer<typeof NachkontrolleErgebnisSchema>;
export type VertraulichErgebnis = z.infer<typeof VertraulichErgebnisSchema>;
export type VerwerfenAbgelehnt = z.infer<typeof VerwerfenAbgelehntSchema>;
export type VerlaufEintrag = z.infer<typeof VerlaufEintragSchema>;

export type EreignisseLesen = z.infer<typeof EreignisseLesenSchema>;
export type EreignisLesen = z.infer<typeof EreignisLesenSchema>;
export type EreignisAktion = z.infer<typeof EreignisAktionSchema>;
export type FolgenAnlegen = z.infer<typeof FolgenAnlegenSchema>;
export type FolgeHinzufuegen = z.infer<typeof FolgeHinzufuegenSchema>;
export type FolgeAktion = z.infer<typeof FolgeAktionSchema>;
export type FolgeVerwerfen = z.infer<typeof FolgeVerwerfenSchema>;
export type EreignisVerwerfenBeantragen = z.infer<typeof EreignisVerwerfenBeantragenSchema>;
export type EreignisErfassen = z.infer<typeof EreignisErfassenSchema>;
export type AnlageVerweis = z.infer<typeof AnlageVerweisSchema>;
export type PortalMeldung = z.infer<typeof PortalMeldungSchema>;
export type PortalMeldungenLesen = z.infer<typeof PortalMeldungenLesenSchema>;
export type EreignisAnlageLesen = z.infer<typeof EreignisAnlageLesenSchema>;
export type EreignisAnlagenJeDokument = z.infer<typeof EreignisAnlagenJeDokumentSchema>;
export type EreignisListenEintrag = z.infer<typeof EreignisListenEintragSchema>;
export type EreignisListe = z.infer<typeof EreignisListeSchema>;
export type FolgeDetail = z.infer<typeof FolgeDetailSchema>;
export type EreignisDetail = z.infer<typeof EreignisDetailSchema>;
export type Anlage = z.infer<typeof AnlageSchema>;
export type EreignisErgebnis = z.infer<typeof EreignisErgebnisSchema>;
export type EreignisErfasst = z.infer<typeof EreignisErfasstSchema>;
export type FolgenAngelegt = z.infer<typeof FolgenAngelegtSchema>;
export type FolgeErgebnis = z.infer<typeof FolgeErgebnisSchema>;
export type PortalMeldungErgebnis = z.infer<typeof PortalMeldungErgebnisSchema>;
export type PortalMeldungen = z.infer<typeof PortalMeldungenSchema>;

export type LandEingabe = z.infer<typeof LandEingabeSchema>;
export type LaenderLesen = z.infer<typeof LaenderLesenSchema>;
export type LandStaendeEingabe = z.infer<typeof LandStaendeSchema>;
export type LandHinzufuegenEingabe = z.infer<typeof LandHinzufuegenSchema>;
export type LandStand = z.infer<typeof LandStandSchema>;
export type Laender = z.infer<typeof LaenderSchema>;
export type LandStaendeErgebnis = z.infer<typeof LandStaendeErgebnisSchema>;
