// =============================================================================
// Vertrag (zod) des Bereichs „risiken-kontrollen" (Welle 2): Eingaben und
// Antworten für Risikoinventar, Kontrollmatrix und Geschäftsprofil.
//
// Grundsätze (ADR 0001 §7, AGENTS.md):
//   - Alle Eingaben sind strikt (unbekannte Felder → UNGUELTIG). Der Mandant
//     steht in jeder Eingabe; Objekt-IDs prüft der Dienst gegen diesen
//     Mandanten. Schreibende Eingaben nehmen keinen Stichtag an (TS-07).
//   - Bewertungen und Frequenzen sind nie Eingaben: Sie werden berechnet
//     (AGENTS.md Regel 2); abweichende Werte entstehen nur als Übersteuerung
//     bzw. Frequenzabweichung mit Begründung und zweiter Person.
//   - Personen sind IDs der kanzleikonsole (UUID). Anzeigenamen löst die
//     kanzleikonsole auf; Antworten tragen nur IDs plus `namen` aus dem
//     Personenverzeichnis des Dienstes (im Dienst leer).
//   - Antworten sind JSON: Zeitpunkte als ISO-8601-Strings, Kalendertage als
//     `YYYY-MM-DD`, keine Map/Set/Date.
//
// Der Vertrag hängt bewusst nur von zod ab (die kanzleikonsole importiert
// ihn); Aufzählungen stehen daher hier als Literale. Der Dienst prüft beim
// Typcheck, dass sie zu `@tcms/domain` passen.
// =============================================================================

import { z } from 'zod';
import {
  BearbeitenRechteSchema,
  einzeilig,
  mitTextBasis,
  PflichtattributLueckeSchema,
  StandSchema,
} from './lesepfade';
import { FreigabeZustellungSchema } from './zustellung';

// -----------------------------------------------------------------------------
// Bausteine
// -----------------------------------------------------------------------------

/** Mindestlänge fachlicher Begründungen (AGENTS.md Regel 2/4, `MIN_BEGRUENDUNG`). */
const MIN_BEGRUENDUNG_ZEICHEN = 30;
/** Höchstlänge fachlicher Begründungen (Schutz vor übergroßen Eingaben). */
const MAX_BEGRUENDUNG_ZEICHEN = 2000;
/** Höchstzahl Risiken je Freigabeschritt. */
export const MAX_RISIKEN_JE_SCHRITT = 200;

const mandantId = z.uuid();
/** ID eines Tax-CMS-Objekts (cuid). Nur harmlose Zeichen, begrenzte Länge. */
const ObjektIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
/** Person der kanzleikonsole (Mitarbeiter- oder Mandantenkontakt-ID). */
const PersonIdSchema = z.uuid();
const BegruendungSchema = mitTextBasis(
  z
    .string()
    .trim()
    .min(MIN_BEGRUENDUNG_ZEICHEN, `mindestens ${MIN_BEGRUENDUNG_ZEICHEN} Zeichen`)
    .max(MAX_BEGRUENDUNG_ZEICHEN),
);
const optionaleBegruendung = mitTextBasis(
  z.string().trim().max(MAX_BEGRUENDUNG_ZEICHEN),
).optional();

const KlasseSchema = z.enum(['GERING', 'MITTEL', 'HOCH', 'KRITISCH']);
const SchadenSchema = z.enum(['N', 'M', 'H']);
const WahrscheinlichkeitSchema = z.enum(['SELTEN', 'MOEGLICH', 'WAHRSCHEINLICH', 'HAEUFIG']);
const ReichweiteSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const GovernanceTypSchema = z.enum(['FP', 'FF', 'IN']);
const TurnusSchema = z.enum(['KEIN', 'JAEHRLICH', 'QUARTALSWEISE', 'MONATLICH']);
const SichtSchema = z.enum(['DESIGN', 'BETRIEB']);
const EntscheidungSchema = z.enum(['FREIGEBEN', 'ABLEHNEN']);
const RisikoFreigabeSchema = z.enum(['IDENTIFIZIERT', 'BEWERTET', 'ZUR_FREIGABE', 'FREIGEGEBEN']);
const DesignSchema = z.enum(['ANGEMESSEN', 'NICHT_BEURTEILT', 'MANGEL']);
/** Katalogcode eines Risikos, z. B. `EC-UST-01`. */
const RisikoCodeSchema = z.string().regex(/^EC-[A-Z]{3}-\d{2}$/);

const zeitpunkt = z.iso.datetime();
const kalendertag = z.iso.date();

/** Ablehnungen brauchen eine Begründung (≥ 30 Zeichen); Freigaben nicht. */
function ablehnungBegruendet(
  e: { entscheidung: 'FREIGEBEN' | 'ABLEHNEN'; begruendung?: string | undefined },
  ctx: z.RefinementCtx,
) {
  if (e.entscheidung === 'ABLEHNEN' && (e.begruendung ?? '').length < MIN_BEGRUENDUNG_ZEICHEN) {
    ctx.addIssue({
      code: 'custom',
      path: ['begruendung'],
      message: `Ablehnung braucht eine Begründung (mindestens ${MIN_BEGRUENDUNG_ZEICHEN} Zeichen)`,
    });
  }
}

// -----------------------------------------------------------------------------
// Eingaben
//
// Je Operation zwei Schemas aus denselben Feldern: `…BodySchema` für den
// HTTP-Body (Mandant und Objekt-ID stehen im Pfad) und `…Schema` für die
// vollständige Eingabe der Service-Funktion (Pfad + Body). Beide sind strikt.
// -----------------------------------------------------------------------------

/** Query der Lese-Endpunkte (`?stand=YYYY-MM-DD`). */
export const RisikenKontrollenQuerySchema = z.object({ stand: StandSchema.optional() }).strict();

export const RisikenLesenSchema = z.object({ mandantId, stand: StandSchema.optional() }).strict();
export const RisikoLesenSchema = z
  .object({ mandantId, risikoId: ObjektIdSchema, stand: StandSchema.optional() })
  .strict();
export const KontrollenLesenSchema = z
  .object({ mandantId, stand: StandSchema.optional() })
  .strict();
export const KontrolleLesenSchema = z
  .object({ mandantId, kontrolleId: ObjektIdSchema, stand: StandSchema.optional() })
  .strict();
export const ProfilLesenSchema = z.object({ mandantId, stand: StandSchema.optional() }).strict();

/**
 * Stand, auf dem die Änderung beruht (aus der Lese-Antwort). Ist inzwischen
 * ein anderer Stand gültig, lehnt der Dienst mit KONFLIKT ab (TS-05: keine
 * Änderung auf einem nicht gesehenen Stand, keine Gabelung).
 */
const standId = ObjektIdSchema;
const risiko = { mandantId, risikoId: ObjektIdSchema };
const kontrolle = { mandantId, kontrolleId: ObjektIdSchema };

/** Pfadparameter der Endpunkte (Endpunktregister, `endpunkte.ts`). */
export const RisikoPfadSchema = z.object(risiko).strict();
export const KontrollePfadSchema = z.object(kontrolle).strict();
export const UebersteuerungPfadSchema = z
  .object({ mandantId, uebersteuerungId: ObjektIdSchema })
  .strict();

// --- Risiken -----------------------------------------------------------------

/** Neubewertung: S, W, R und GT; Klassen berechnet der Dienst (Regel 2). */
const neuBewerten = {
  standId,
  s: SchadenSchema,
  w: WahrscheinlichkeitSchema,
  r: ReichweiteSchema,
  gt: GovernanceTypSchema,
  begruendung: BegruendungSchema,
};
export const RisikoNeuBewertenBodySchema = z.object(neuBewerten).strict();
export const RisikoNeuBewertenSchema = z.object({ ...risiko, ...neuBewerten }).strict();

/** Bestätigt die aktuelle Bewertung unverändert (neuer Stand mit gleichen Werten). */
const bestaetigen = { standId, begruendung: BegruendungSchema };
export const RisikoBestaetigenBodySchema = z.object(bestaetigen).strict();
export const RisikoBestaetigenSchema = z.object({ ...risiko, ...bestaetigen }).strict();

const uebersteuern = { sicht: SichtSchema, klasse: KlasseSchema, begruendung: BegruendungSchema };
export const UebersteuerungBeantragenBodySchema = z.object(uebersteuern).strict();
export const UebersteuerungBeantragenSchema = z.object({ ...risiko, ...uebersteuern }).strict();

const entscheiden = { entscheidung: EntscheidungSchema, begruendung: optionaleBegruendung };
export const UebersteuerungEntscheidenBodySchema = z
  .object(entscheiden)
  .strict()
  .superRefine(ablehnungBegruendet);
export const UebersteuerungEntscheidenSchema = z
  .object({ mandantId, uebersteuerungId: ObjektIdSchema, ...entscheiden })
  .strict()
  .superRefine(ablehnungBegruendet);

/** Risiken zur Freigabe einreichen bzw. freigeben (Auswahl, ohne Dubletten). */
const freigabeSchritt = {
  risikoIds: z
    .array(ObjektIdSchema)
    .min(1)
    .max(MAX_RISIKEN_JE_SCHRITT)
    .refine((ids) => new Set(ids).size === ids.length, 'Risiko doppelt ausgewählt'),
};
export const RisikenFreigabeSchrittBodySchema = z.object(freigabeSchritt).strict();
export const RisikenFreigabeSchrittSchema = z.object({ mandantId, ...freigabeSchritt }).strict();

const zurueckweisen = { begruendung: BegruendungSchema };
export const RisikoZurueckweisenBodySchema = z.object(zurueckweisen).strict();
export const RisikoZurueckweisenSchema = z.object({ ...risiko, ...zurueckweisen }).strict();

const akzeptanz = {
  /** Gesetzliche:r Vertreter:in des Mandanten (aktive MandantKontaktRolle). */
  empfaengerId: PersonIdSchema,
  begruendung: BegruendungSchema,
};
export const RisikoakzeptanzAnfordernBodySchema = z.object(akzeptanz).strict();
export const RisikoakzeptanzAnfordernSchema = z.object({ ...risiko, ...akzeptanz }).strict();

// --- Kontrollen --------------------------------------------------------------

const design = {
  standId,
  design: z.enum(['ANGEMESSEN', 'MANGEL']),
  begruendung: BegruendungSchema,
};
export const DesignBeurteilenBodySchema = z.object(design).strict();
export const DesignBeurteilenSchema = z.object({ ...kontrolle, ...design }).strict();

const abweichung = {
  standId,
  turnus: TurnusSchema,
  anlass: z.boolean(),
  begruendung: BegruendungSchema,
};
export const AbweichungBeantragenBodySchema = z.object(abweichung).strict();
export const AbweichungBeantragenSchema = z.object({ ...kontrolle, ...abweichung }).strict();

/** Entscheidung über genau den gesehenen Antrag (Stand mit der offenen Abweichung). */
const abweichungEntscheiden = { standId, ...entscheiden };
export const AbweichungEntscheidenBodySchema = z
  .object(abweichungEntscheiden)
  .strict()
  .superRefine(ablehnungBegruendet);
export const AbweichungEntscheidenSchema = z
  .object({ ...kontrolle, ...abweichungEntscheiden })
  .strict()
  .superRefine(ablehnungBegruendet);

const aufheben = { standId, begruendung: BegruendungSchema };
export const AbweichungAufhebenBodySchema = z.object(aufheben).strict();
export const AbweichungAufhebenSchema = z.object({ ...kontrolle, ...aufheben }).strict();

/**
 * Zuständigkeiten einer Kontrolle. Kanzleiseite: IDs der kanzleikonsole (nur
 * UUID-Form prüfbar); Mandantenseite: Kontakte mit aktiver Rolle beim Mandanten.
 * Bei `gegenzeichnungMandant` bestätigt die Vertretung beim Mandanten; dann
 * bleibt `gegenzeichnerId` ungenutzt und muss `null` sein.
 *
 * `partei` ist die Seite der Kontrolle, die der Aufrufer gesehen hat (aus der
 * Lese-Antwort) und für die er Personen anbietet. Der Dienst prüft sie unter
 * der Zeilensperre gegen den Kontrollstand; weicht sie ab → KONFLIKT (TS-05).
 * Eine Gegenzeichnung beim Mandanten gibt es nur bei `partei: 'MANDANT'`.
 */
const verantwortliche = {
  standId,
  partei: z.enum(['KANZLEI', 'MANDANT']),
  durchfuehrendId: PersonIdSchema,
  vertretungId: PersonIdSchema,
  gegenzeichnerId: PersonIdSchema.nullable(),
  gegenzeichnungMandant: z.boolean(),
};
function gegenzeichnungEindeutig(
  e: {
    partei: 'KANZLEI' | 'MANDANT';
    gegenzeichnungMandant: boolean;
    gegenzeichnerId: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (e.gegenzeichnungMandant && e.gegenzeichnerId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['gegenzeichnerId'],
      message: 'Bei Gegenzeichnung beim Mandanten keine gegenzeichnende Person angeben',
    });
  }
  if (e.gegenzeichnungMandant && e.partei !== 'MANDANT') {
    ctx.addIssue({
      code: 'custom',
      path: ['gegenzeichnungMandant'],
      message: 'Eine Gegenzeichnung beim Mandanten gibt es nur bei Kontrollen des Mandanten',
    });
  }
}
export const VerantwortlicheAendernBodySchema = z
  .object(verantwortliche)
  .strict()
  .superRefine(gegenzeichnungEindeutig);
export const VerantwortlicheAendernSchema = z
  .object({ ...kontrolle, ...verantwortliche })
  .strict()
  .superRefine(gegenzeichnungEindeutig);

// --- Geschäftsprofil ---------------------------------------------------------

const monat = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const land = z.string().regex(/^[A-Z]{2}$/);
const betrag = z.number().finite().min(0).max(1e12);
type Bezeichnung = (max?: number) => z.ZodType<string, string>;
/** Bezeichnung einer Eingabe (Shop, Marktplatz, Warengruppe, System …): einzeilig, darf leer sein. */
const bezeichnung: Bezeichnung = (max = 120) => einzeilig(0, max);
/** Gespeicherte Bezeichnung: nur Länge, damit Profile vor RT4-T-03 lesbar bleiben. */
const bezeichnungGespeichert: Bezeichnung = (max = 120) => z.string().trim().max(max);

/** Geschäftsprofil P1–P12 (Fachkonzept §4) mit der Regel `text` für Bezeichnungen. */
function profilSchema(text: Bezeichnung) {
  return z
    .object({
      p1: z
        .object({
          eigenerShop: z.boolean(),
          shopSystem: text(),
          marktplaetze: z.array(text(40)).max(20),
        })
        .strict(),
      p2: z
        .object({
          eigenversandDE: z.boolean(),
          lager: z
            .array(
              z
                .object({
                  land,
                  seit: monat,
                  art: z.enum(['EIGEN', 'FBA', 'PAN-EU', 'CEE', '3PL']),
                })
                .strict(),
            )
            .max(40),
        })
        .strict(),
      p3: z
        .object({
          laender: z.array(land).max(40),
          b2bAnteilProzent: z.number().finite().min(0).max(100),
          b2bEU: z.boolean(),
          b2bInland: z.boolean(),
        })
        .strict(),
      p4: z
        .object({
          warengruppen: z
            .array(z.object({ name: text(), abweichenderSatz: z.boolean() }).strict())
            .max(40),
          gebrauchtware: z.boolean(),
        })
        .strict(),
      p5: z
        .object({
          drittlandImport: z.boolean(),
          laender: z.array(land).max(40),
          zollabwicklung: text(200),
        })
        .strict(),
      p6: z.object({ zahlungswege: z.array(text(40)).max(20) }).strict(),
      p7: z.object({ gutscheine: z.boolean(), abos: z.boolean(), bundles: z.boolean() }).strict(),
      p8: z
        .object({
          systeme: z
            .array(z.object({ art: text(60), name: text(), version: text(40) }).strict())
            .max(30),
        })
        .strict(),
      p9: z
        .object({
          ossSeit: monat.nullable(),
          ioss: z.boolean(),
          lokaleUstNr: z.array(land).max(40),
          dauerfrist: z.boolean(),
        })
        .strict(),
      p10: z
        .object({
          vorjahresumsatzEur: betrag,
          euFernverkaeufeVorjahrEur: betrag,
          euFernverkaeufeLfdEur: betrag,
        })
        .strict(),
      p11: z.object({ vorhanden: z.boolean(), anbieter: z.array(text()).max(30) }).strict(),
      p12: z.object({ buchhaltung: z.enum(['KANZLEI', 'INTERN']) }).strict(),
    })
    .strict();
}

/**
 * Geschäftsprofil P1–P12 als Eingabe (Profiländerung, Einrichtung);
 * Zusatzfelder werden abgewiesen, Bezeichnungen sind einzeilig (RT4-T-03:
 * Shop-System und Marktplätze erscheinen als Kanäle in eingefrorenen
 * Beschreibungen).
 */
export const ProfilAntwortenSchema = profilSchema(bezeichnung);
/**
 * Gespeichertes Geschäftsprofil (Antworten, gespeicherte Entwürfe, Lesen im
 * Dienst): dieselbe Struktur, Bezeichnungen nur mit Längengrenze, damit vor
 * RT4-T-03 gespeicherte Profile lesbar bleiben.
 */
export const ProfilAntwortenGespeichertSchema = profilSchema(bezeichnungGespeichert);

export type ProfilAntworten = z.infer<typeof ProfilAntwortenSchema>;

/**
 * Profiländerung als neuer Profilstand (AGENTS.md Regel 3). `gueltigAb` ist
 * der Beginn der Gültigkeit des neuen Stands (frühestens heute, höchstens ein
 * Jahr voraus) – kein Lese-Stichtag. `ereignisseAnlegen` legt die
 * Ereignisse der geänderten Profilfragen an (Fachkonzept §4).
 */
const profilAendern = {
  /** Offener Profilstand, auf dem die Änderung beruht (sonst KONFLIKT). */
  profilStandId: ObjektIdSchema,
  profil: ProfilAntwortenSchema,
  gueltigAb: kalendertag,
  ereignisseAnlegen: z.boolean(),
};
export const ProfilAendernBodySchema = z.object(profilAendern).strict();
export const ProfilAendernSchema = z.object({ mandantId, ...profilAendern }).strict();

/**
 * Verantwortliche Person, die die kanzleikonsole ausdrücklich übergibt
 * (Nachtrag Welle 2): nur Vorbelegung, nie Grundlage von Rechten. Der Name
 * dient nur der Anzeige beim Aufrufer und wird nicht gespeichert.
 */
export const AufnahmePersonSchema = z
  .object({ id: PersonIdSchema, name: einzeilig(1, 200) })
  .strict();

/**
 * Vorgeschlagenes Risiko ins Inventar aufnehmen. Neue Kontrollen werden mit
 * den übergebenen Kanzleipersonen und den Rollen der Mandantenseite
 * (MandantKontaktRolle) vorbelegt.
 */
const aufnehmen = {
  code: RisikoCodeSchema,
  verantwortliche: z
    .object({
      berufstraeger: AufnahmePersonSchema,
      hauptbearbeitung: AufnahmePersonSchema,
      /** Vertretung der Kanzleiseite (weder Berufsträger:in noch Hauptbearbeitung). */
      vertretung: AufnahmePersonSchema.nullable(),
    })
    .strict()
    .superRefine((v, ctx) => {
      const ids = [v.berufstraeger.id, v.hauptbearbeitung.id, v.vertretung?.id]
        .filter((x): x is string => !!x)
        .map((x) => x.toLowerCase());
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: 'custom',
          message: 'Berufsträger:in, Hauptbearbeitung und Vertretung müssen verschieden sein',
        });
      }
    }),
};
export const RisikoAufnehmenBodySchema = z.object(aufnehmen).strict();
export const RisikoAufnehmenSchema = z.object({ mandantId, ...aufnehmen }).strict();

export type RisikenLesen = z.infer<typeof RisikenLesenSchema>;
export type RisikoLesen = z.infer<typeof RisikoLesenSchema>;
export type KontrollenLesen = z.infer<typeof KontrollenLesenSchema>;
export type KontrolleLesen = z.infer<typeof KontrolleLesenSchema>;
export type ProfilLesen = z.infer<typeof ProfilLesenSchema>;
export type RisikoNeuBewerten = z.infer<typeof RisikoNeuBewertenSchema>;
export type RisikoBestaetigen = z.infer<typeof RisikoBestaetigenSchema>;
export type UebersteuerungBeantragen = z.infer<typeof UebersteuerungBeantragenSchema>;
export type UebersteuerungEntscheiden = z.infer<typeof UebersteuerungEntscheidenSchema>;
export type RisikenFreigabeSchritt = z.infer<typeof RisikenFreigabeSchrittSchema>;
export type RisikoZurueckweisen = z.infer<typeof RisikoZurueckweisenSchema>;
export type RisikoakzeptanzAnfordern = z.infer<typeof RisikoakzeptanzAnfordernSchema>;
export type DesignBeurteilen = z.infer<typeof DesignBeurteilenSchema>;
export type AbweichungBeantragen = z.infer<typeof AbweichungBeantragenSchema>;
export type AbweichungEntscheiden = z.infer<typeof AbweichungEntscheidenSchema>;
export type AbweichungAufheben = z.infer<typeof AbweichungAufhebenSchema>;
export type VerantwortlicheAendern = z.infer<typeof VerantwortlicheAendernSchema>;
export type ProfilAendern = z.infer<typeof ProfilAendernSchema>;
export type RisikoAufnehmen = z.infer<typeof RisikoAufnehmenSchema>;

// -----------------------------------------------------------------------------
// Antworten: Bausteine
// -----------------------------------------------------------------------------

const personRef = z.string().nullable();
/** Anzeigenamen je Personen-ID aus dem Personenverzeichnis (im Dienst leer). */
const namen = z.record(z.string(), z.string());

const FrequenzSchema = z.object({ turnus: TurnusSchema, anlass: z.boolean() }).strict();

export const KontrollNeuplanungSchema = z
  .object({
    kontrolleId: z.string(),
    code: z.string(),
    turnusVorher: TurnusSchema,
    turnusNachher: TurnusSchema,
    /** Periodenlabels der entfernten (nur geplante, unberührte) Durchführungen. */
    entfernt: z.array(z.string()),
    angelegt: z.array(z.string()),
    behalten: z.array(z.string()),
    /** Planungshorizont (Kalendertag). */
    bis: kalendertag,
  })
  .strict();

const bruttoSchema = z
  .object({
    klasse: KlasseSchema,
    punkte: z.number(),
    basis: KlasseSchema,
    angehoben: z.boolean(),
    erklaerung: z.string(),
  })
  .strict();
const nettoSchema = z
  .object({
    klasse: KlasseSchema,
    abschlag: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    erklaerung: z.string(),
    zaehlend: z.array(z.string()),
  })
  .strict();

/** Berechnete Bewertung (Modell `ec-1.0`); wirksam = nach freigegebener Übersteuerung. */
export const RisikoBewertungSchema = z
  .object({
    brutto: bruttoSchema,
    nettoDesign: nettoSchema,
    nettoBetrieb: nettoSchema,
    wirksamDesign: KlasseSchema,
    wirksamBetrieb: KlasseSchema,
    uebersteuertDesign: z.boolean(),
    uebersteuertBetrieb: z.boolean(),
    modell: z.string(),
  })
  .strict();

export const KontrollFrequenzAbleitungSchema = z
  .object({
    mindest: FrequenzSchema,
    effektiv: FrequenzSchema,
    gt: GovernanceTypSchema.nullable(),
    quelle: z
      .object({ code: z.string(), gt: GovernanceTypSchema, brutto: KlasseSchema })
      .strict()
      .nullable(),
    abweichendVonVorlage: z.boolean(),
    begruendung: z.string(),
  })
  .strict();

export const AuditSpurZeileSchema = z
  .object({
    /** Position im Audit des Tenants (RT-03). */
    pos: z.number().int(),
    at: zeitpunkt,
    actorId: personRef,
    aktion: z.string(),
    detail: z.record(z.string(), z.unknown()),
  })
  .strict();

const lesestand = {
  mandantId: z.string(),
  programmId: z.string().nullable(),
  heute: kalendertag,
  stand: kalendertag,
  /** Stand vor heute: schreibgeschützt (AGENTS.md Regel 6). */
  historisch: z.boolean(),
};

// -----------------------------------------------------------------------------
// Antworten: Risiken
// -----------------------------------------------------------------------------

export const UebersteuerungEintragSchema = z
  .object({
    id: z.string(),
    sicht: SichtSchema,
    klasse: KlasseSchema,
    berechnet: KlasseSchema,
    begruendung: z.string(),
    status: z.enum(['BEANTRAGT', 'FREIGEGEBEN', 'ABGELEHNT', 'AUFGEHOBEN']),
    beantragtVon: z.string(),
    beantragtAm: zeitpunkt,
    entschiedenVon: personRef,
    entschiedenAm: zeitpunkt.nullable(),
  })
  .strict();

/** Deterministischer Hinweis „neu bewerten" mit Grund (AGENTS.md Regel 7). */
export const NeuBewertenHinweisSchema = z
  .object({
    quelle: z.enum(['EREIGNIS', 'PROFIL', 'MARKIERT']),
    text: z.string(),
    ereignisId: z.string().nullable(),
  })
  .strict();

export const RisikoakzeptanzEintragSchema = z
  .object({
    id: z.string(),
    status: z.enum(['OFFEN', 'FREIGEGEBEN', 'ABGELEHNT']),
    titel: z.string(),
    inhalt: z.string().nullable(),
    angefordertVon: z.string(),
    angefordertAm: zeitpunkt,
    empfaengerId: z.string(),
    anmerkung: z.string().nullable(),
    erledigtAm: zeitpunkt.nullable(),
    /** Zustellung der jüngsten Nachricht an den aktuellen Empfänger (historisch: null). */
    zustellung: FreigabeZustellungSchema.nullable(),
  })
  .strict();

export const RisikoEintragSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    gruppe: z.enum(['UST', 'GOB', 'ERT', 'VER']),
    gruppeLabel: z.string(),
    kern: z.boolean(),
    herkunft: z.enum(['KATALOG', 'BERATER']),
    freigabe: RisikoFreigabeSchema,
    freigabeEingereichtVon: personRef,
    freigegebenVon: personRef,
    freigegebenAm: zeitpunkt.nullable(),
    ownerId: personRef,
    neuBewerten: z.boolean(),
    vorschlagsgrund: z.string().nullable(),
    standId: z.string(),
    titel: z.string(),
    fehlerquelle: z.string(),
    folge: z.string(),
    normanker: z
      .array(
        z
          .object({ text: z.string(), stufe: z.enum(['GEPRUEFT', 'UNGEPRUEFT', 'KI_VERMUTUNG']) })
          .strict(),
      )
      .readonly(),
    s: SchadenSchema,
    w: WahrscheinlichkeitSchema,
    r: ReichweiteSchema,
    gt: GovernanceTypSchema,
    /** Beginn des gültigen Risikostands (letzte Bewertung). */
    gueltigAb: zeitpunkt,
    kontrollIds: z.array(z.string()),
    bewertung: RisikoBewertungSchema,
    /** Maßgebliche Nettoklasse für den Risikoappetit (Betrieb ab Wirksamkeitsbeginn). */
    netto: KlasseSchema,
    ueberAppetit: z.boolean(),
    uebersteuerungen: z.array(UebersteuerungEintragSchema),
    offeneEreignisse: z.number().int(),
    wirktAuf: z.array(z.string()).readonly(),
    hinweise: z.array(NeuBewertenHinweisSchema),
    /** Risikoakzeptanzen bis zum Stichtag, jüngste zuerst. */
    akzeptanzen: z.array(RisikoakzeptanzEintragSchema),
  })
  .strict();

export const RisikenListeSchema = z
  .object({
    ...lesestand,
    /** Risiken bearbeiten (Neubewertung, Übersteuerung, Freigabe …): wie die Schreiboperationen. */
    rechte: BearbeitenRechteSchema,
    appetit: KlasseSchema,
    /** Wirksamkeitszeitraum begonnen: Netto (Betrieb) ist maßgeblich. */
    betriebAktiv: z.boolean(),
    risiken: z.array(RisikoEintragSchema),
    /** Offene Katalogvorschläge aus dem Geschäftsprofil. */
    vorschlaegeOffen: z.number().int(),
    namen,
  })
  .strict();

export const RisikoStandEintragSchema = z
  .object({
    id: z.string(),
    version: z.number().int(),
    s: SchadenSchema,
    w: WahrscheinlichkeitSchema,
    r: ReichweiteSchema,
    gt: GovernanceTypSchema,
    brutto: KlasseSchema,
    modell: z.string(),
    gueltigAb: zeitpunkt,
    /** Zum Stichtag geschlossen; ein später geschlossener Stand gilt als offen. */
    gueltigBis: zeitpunkt.nullable(),
    erstelltVon: personRef,
  })
  .strict();

export const RisikoDetailSchema = z
  .object({
    ...lesestand,
    appetit: KlasseSchema,
    betriebAktiv: z.boolean(),
    risiko: RisikoEintragSchema,
    aktivAb: zeitpunkt,
    staende: z.array(RisikoStandEintragSchema),
    kontrollen: z.array(
      z
        .object({
          id: z.string(),
          code: z.string(),
          titel: z.string(),
          art: z.enum(['P', 'D', 'K']),
          schluessel: z.boolean(),
          design: DesignSchema,
          betrieb: z.enum(['OK', 'MIT_BEFUND', 'UEBERFAELLIG', 'KEINE']),
          frequenz: FrequenzSchema,
        })
        .strict(),
    ),
    audit: z.array(AuditSpurZeileSchema),
    namen,
  })
  .strict();

export const NeuBewertungErgebnisSchema = z
  .object({
    risikoId: z.string(),
    code: z.string(),
    standId: z.string(),
    version: z.number().int(),
    geaendert: z.boolean(),
    brutto: z.object({ vorher: KlasseSchema, nachher: KlasseSchema }).strict(),
    freigabe: z.object({ vorher: RisikoFreigabeSchema, nachher: RisikoFreigabeSchema }).strict(),
    frequenzHinweise: z.array(z.string()),
    neuplanungen: z.array(KontrollNeuplanungSchema),
  })
  .strict();

export const UebersteuerungBeantragtSchema = z
  .object({
    uebersteuerungId: z.string(),
    sicht: SichtSchema,
    klasse: KlasseSchema,
    berechnet: KlasseSchema,
  })
  .strict();

export const UebersteuerungEntschiedenSchema = z
  .object({
    uebersteuerungId: z.string(),
    risikoId: z.string(),
    status: z.enum(['FREIGEGEBEN', 'ABGELEHNT']),
  })
  .strict();

export const FreigabeSchrittErgebnisSchema = z
  .object({
    bearbeitet: z.array(z.object({ risikoId: z.string(), code: z.string() }).strict()),
    uebersprungen: z.array(
      z.object({ risikoId: z.string(), code: z.string(), grund: z.string() }).strict(),
    ),
  })
  .strict();

export const RisikoZurueckgewiesenSchema = z
  .object({ risikoId: z.string(), code: z.string(), freigabe: RisikoFreigabeSchema })
  .strict();

export const RisikoakzeptanzAngefordertSchema = z
  .object({ risikoId: z.string(), freigabeId: z.string(), empfaengerId: z.string() })
  .strict();

// -----------------------------------------------------------------------------
// Antworten: Kontrollen
// -----------------------------------------------------------------------------

export const KontrollDurchfuehrungSchema = z
  .object({
    id: z.string(),
    periodeLabel: z.string(),
    periodeVon: zeitpunkt,
    periodeBis: zeitpunkt,
    faelligAm: zeitpunkt,
    status: z.string(),
    anzeige: z.enum([
      'GEPLANT',
      'FAELLIG',
      'IN_DURCHFUEHRUNG',
      'ZUR_GEGENZEICHNUNG',
      'ZURUECKGEWIESEN',
      'OHNE_BEFUND',
      'MIT_BEFUND',
      'UEBERFAELLIG',
      'ENTFALLEN',
    ]),
    ausserplanmaessig: z.boolean(),
    anlass: z.string().nullable(),
    durchgefuehrtVon: personRef,
    gegengezeichnetVon: personRef,
    mandantBestaetigtVon: personRef,
    eingereichtAm: zeitpunkt.nullable(),
    abgeschlossenAm: zeitpunkt.nullable(),
    nachweise: z.number().int(),
    mindestNachweise: z.number().int(),
    /**
     * Feststellung aus dieser Durchführung (Nummer ist nicht vertraulich). Bei
     * einer vertraulichen Feststellung, an der der Akteur nicht beteiligt ist,
     * ohne §-153-Kennzeichen (`maskiert: true`, RT-01).
     */
    feststellung: z
      .discriminatedUnion('maskiert', [
        z
          .object({
            maskiert: z.literal(false),
            id: z.string(),
            nummer: z.string(),
            p153Offen: z.boolean(),
          })
          .strict(),
        z.object({ maskiert: z.literal(true), id: z.string(), nummer: z.string() }).strict(),
      ])
      .nullable(),
  })
  .strict();

export const KontrolleEintragSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    standId: z.string(),
    version: z.number().int(),
    titel: z.string(),
    ziel: z.string(),
    art: z.enum(['P', 'D', 'K']),
    ausfuehrung: z.enum(['M', 'IT', 'A']),
    vorlage: FrequenzSchema,
    /** Beantragte oder freigegebene Frequenzabweichung. */
    abweichung: z
      .object({
        frequenz: FrequenzSchema,
        begruendung: z.string().nullable(),
        freigegebenVon: personRef,
        beantragtVon: personRef,
        beantragtAm: zeitpunkt.nullable(),
      })
      .strict()
      .nullable(),
    partei: z.enum(['KANZLEI', 'MANDANT']),
    schluessel: z.boolean(),
    durchfuehrendId: personRef,
    vertretungId: personRef,
    gegenzeichnerId: personRef,
    gegenzeichnungMandant: z.boolean(),
    nachweis: z.string(),
    mindestNachweise: z.number().int(),
    schritte: z.array(z.object({ titel: z.string(), hinweis: z.string() }).strict()),
    kennzahlen: z.array(
      z
        .object({
          key: z.string(),
          label: z.string(),
          sollEur: z.number().nullable(),
          differenzAus: z.tuple([z.string(), z.string()]).optional(),
        })
        .strict(),
    ),
    toleranzEur: z.number().nullable(),
    faelligNachTagen: z.number().int(),
    design: DesignSchema,
    designVon: personRef,
    designAm: zeitpunkt.nullable(),
    designBegruendung: z.string().nullable(),
    risikoIds: z.array(z.string()),
    risikoCodes: z.array(z.string()),
    /** Berechnete Frequenz aus Vorlage und Häufigkeitsmatrix (GT × Bruttoklasse). */
    ableitung: KontrollFrequenzAbleitungSchema,
    /** Effektive Frequenz (freigegebene Abweichung, sonst Ableitung). */
    frequenz: FrequenzSchema,
    gt: GovernanceTypSchema.nullable(),
    betrieb: z.enum(['OK', 'MIT_BEFUND', 'UEBERFAELLIG', 'KEINE']),
    letzte: KontrollDurchfuehrungSchema.nullable(),
    naechste: KontrollDurchfuehrungSchema.nullable(),
    pflichtattributeOk: z.boolean(),
    /** Fehlende Pflichtattribute (feste Texte); leer genau bei `pflichtattributeOk`. */
    pflichtattributeLuecken: z.array(PflichtattributLueckeSchema),
  })
  .strict();

export const KontrollenListeSchema = z
  .object({
    ...lesestand,
    /** Kontrollen bearbeiten (Design, Abweichung, Zuständigkeiten): wie die Schreiboperationen. */
    rechte: BearbeitenRechteSchema,
    wirksamAb: zeitpunkt.nullable(),
    kontrollen: z.array(KontrolleEintragSchema),
    namen,
  })
  .strict();

export const KontrolleStandEintragSchema = z
  .object({
    id: z.string(),
    version: z.number().int(),
    gueltigAb: zeitpunkt,
    gueltigBis: zeitpunkt.nullable(),
    erstelltVon: personRef,
    design: DesignSchema,
    designVon: personRef,
    designAm: zeitpunkt.nullable(),
    designBegruendung: z.string().nullable(),
    durchfuehrendId: personRef,
    vertretungId: personRef,
    gegenzeichnerId: personRef,
    gegenzeichnungMandant: z.boolean(),
    abweichung: z
      .object({
        turnus: TurnusSchema,
        anlass: z.boolean(),
        begruendung: z.string().nullable(),
        freigegebenVon: personRef,
      })
      .strict()
      .nullable(),
    /** Kurzbeschreibung der Änderung gegenüber dem Vorgängerstand. */
    aenderungen: z.array(z.string()),
  })
  .strict();

export const KontrolleDetailSchema = z
  .object({
    ...lesestand,
    kontrolle: KontrolleEintragSchema,
    staende: z.array(KontrolleStandEintragSchema),
    durchfuehrungen: z.array(KontrollDurchfuehrungSchema),
    audit: z.array(AuditSpurZeileSchema),
    namen,
  })
  .strict();

export const KontrolleGeaendertSchema = z
  .object({
    kontrolleId: z.string(),
    standId: z.string(),
    version: z.number().int(),
    frequenz: FrequenzSchema,
    neuplanung: KontrollNeuplanungSchema.nullable(),
  })
  .strict();

// -----------------------------------------------------------------------------
// Antworten: Geschäftsprofil
// -----------------------------------------------------------------------------

export const ProfilDatenSchema = z
  .object({
    ...lesestand,
    version1Am: zeitpunkt.nullable(),
    /**
     * Bis zum Stichtag erfasste Profilstände (auch im Voraus erfasste, später
     * gültige), aufsteigend nach Beginn; `gueltigBis` nach dem Stichtag gilt als offen.
     */
    staende: z.array(
      z
        .object({
          id: z.string(),
          version: z.number().int(),
          antworten: ProfilAntwortenGespeichertSchema,
          gueltigAb: zeitpunkt,
          gueltigBis: zeitpunkt.nullable(),
          erstelltVon: personRef,
          createdAt: zeitpunkt,
        })
        .strict(),
    ),
    /** Deterministische Katalogvorschläge des zum Stichtag gültigen Profils mit Grund. */
    vorschlaege: z.array(
      z
        .object({
          code: z.string(),
          kern: z.boolean(),
          grund: z.string(),
          frage: z.string(),
          entscheidung: z.enum(['OFFEN', 'UEBERNOMMEN', 'ABGELEHNT', 'DEAKTIVIERT']),
          risikoId: z.string().nullable(),
        })
        .strict(),
    ),
    risiken: z.array(
      z
        .object({
          id: z.string(),
          code: z.string(),
          kern: z.boolean(),
          entscheidung: z.enum(['VORGESCHLAGEN', 'UEBERNOMMEN', 'ABGELEHNT']),
          vorschlagsgrund: z.string().nullable(),
          ablehnungsgrund: z.string().nullable(),
          inaktivAb: zeitpunkt.nullable(),
          neuBewerten: z.boolean(),
          createdAt: zeitpunkt,
        })
        .strict(),
    ),
    namen,
  })
  .strict();

export const ProfilGeaendertSchema = z
  .object({
    profilStandId: z.string(),
    version: z.number().int(),
    gueltigAb: zeitpunkt,
    /** Aktive Risiken, deren Grundlage sich ändert (zur Neubewertung markiert). */
    neuBewerten: z.array(z.object({ code: z.string(), grund: z.string() }).strict()),
    /** Nummern der angelegten Ereignisse. */
    ereignisse: z.array(z.string()),
    /** Neu vorgeschlagene, noch nicht übernommene Katalogrisiken. */
    neuVorgeschlagen: z.array(z.string()),
  })
  .strict();

export const RisikoAufgenommenSchema = z
  .object({
    risikoId: z.string(),
    code: z.string(),
    neueKontrollen: z.array(z.string()),
    verknuepft: z.array(z.string()),
    neuGeplant: z.array(
      z
        .object({
          code: z.string(),
          vorher: TurnusSchema,
          nachher: TurnusSchema,
          entfernt: z.number().int(),
          angelegt: z.number().int(),
        })
        .strict(),
    ),
    durchfuehrungen: z.number().int(),
  })
  .strict();

export type KontrollFrequenz = z.infer<typeof FrequenzSchema>;
export type KontrollNeuplanung = z.infer<typeof KontrollNeuplanungSchema>;
export type AuditSpurZeile = z.infer<typeof AuditSpurZeileSchema>;
export type NeuBewertenHinweis = z.infer<typeof NeuBewertenHinweisSchema>;
export type RisikoakzeptanzEintrag = z.infer<typeof RisikoakzeptanzEintragSchema>;
export type RisikoEintrag = z.infer<typeof RisikoEintragSchema>;
export type RisikenListe = z.infer<typeof RisikenListeSchema>;
export type RisikoStandEintrag = z.infer<typeof RisikoStandEintragSchema>;
export type RisikoDetail = z.infer<typeof RisikoDetailSchema>;
export type NeuBewertungErgebnis = z.infer<typeof NeuBewertungErgebnisSchema>;
export type UebersteuerungBeantragt = z.infer<typeof UebersteuerungBeantragtSchema>;
export type UebersteuerungEntschieden = z.infer<typeof UebersteuerungEntschiedenSchema>;
export type FreigabeSchrittErgebnis = z.infer<typeof FreigabeSchrittErgebnisSchema>;
export type RisikoZurueckgewiesen = z.infer<typeof RisikoZurueckgewiesenSchema>;
export type RisikoakzeptanzAngefordert = z.infer<typeof RisikoakzeptanzAngefordertSchema>;
export type KontrollDurchfuehrung = z.infer<typeof KontrollDurchfuehrungSchema>;
export type KontrolleEintrag = z.infer<typeof KontrolleEintragSchema>;
export type KontrollenListe = z.infer<typeof KontrollenListeSchema>;
export type KontrolleStandEintrag = z.infer<typeof KontrolleStandEintragSchema>;
export type KontrolleDetail = z.infer<typeof KontrolleDetailSchema>;
export type KontrolleGeaendert = z.infer<typeof KontrolleGeaendertSchema>;
export type ProfilDaten = z.infer<typeof ProfilDatenSchema>;
export type ProfilGeaendert = z.infer<typeof ProfilGeaendertSchema>;
export type RisikoAufgenommen = z.infer<typeof RisikoAufgenommenSchema>;
