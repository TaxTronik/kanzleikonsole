// =============================================================================
// Endpunktregister des Dienstes (ADR 0001 §7, Stufe 2): ein Eintrag je
// Endpunkt mit Methode, Pfadmuster, Portal-Kennzeichen, Mandantenbezug und den
// zod-Schemas für Pfadparameter, Query, Body und Antwort (`daten` im Umschlag
// `{ ok: true, daten }`).
//
// Eine Quelle der Wahrheit für beide Seiten:
//   - Der Dienst (`apps/api`) registriert jede Route aus diesem Register
//     (`Routen.endpunkt`) und prüft beim Start, dass Routentabelle und
//     Register übereinstimmen. Pfadparameter, Query und Body prüft er mit den
//     Schemas von hier; die API-Tests prüfen jede Erfolgsantwort gegen
//     `antwortSchema`.
//   - Die kanzleikonsole speist ihren generischen Client direkt mit einem
//     Eintrag (`methode`, `pfad`, `querySchema`, `bodySchema`, `antwortSchema`).
//
// Muster: feste Segmente `[a-z0-9-]+`, Parameter `:name`; `:mandantId` nur als
// `/v1/mandanten/:mandantId/…` (dann `mandantenbezogen`, an `cli.id` gebunden,
// ADR 0001 §3.3). Nur `health` braucht keine Akteursbestätigung
// (`akteur: false`, ADR 0001 §7).
//
// Akteursarten (`akteure`, ADR 0001 §3.3, §7): Jeder Eintrag nennt die Arten,
// die ihn aufrufen dürfen – Standard nur `KANZLEI`. Jede andere Art erhält 404
// wie ein unbekannter Pfad. Der Systemakteur steht nur allein (`['SYSTEM']`)
// und nie auf Mandantenpfaden; Portal-Pfade (`…/portal/…`) sind nur für
// Mandantenkontakte (`['MANDANT']`), Mandantenkontakte erreichen nur sie und
// `/v1/ich` (Stufe 5). `register` weist andere Definitionen beim Laden ab.
// `portal` wird daraus abgeleitet (`akteure` enthält `MANDANT`) und bleibt nur
// für bestehende Aufrufer.
//
// Der Vertrag hängt nur von zod ab; alle Schemas stammen aus `bereiche/*`.
// =============================================================================

import { z } from 'zod';
import { AKTEUR_ARTEN, type AkteurArt } from './akteur';
import {
  DurchfuehrungBegruendungBodySchema,
  DurchfuehrungDetailSchema,
  DurchfuehrungSpeichernBodySchema,
  DurchfuehrungSpeichernErgebnisSchema,
  DurchfuehrungStandQuerySchema,
  DurchfuehrungUebergangSchema,
  DurchfuehrungZielSchema,
  EntfallenAblehnenBodySchema,
  GegenzeichnenBodySchema,
  GegenzeichnenErgebnisSchema,
  KontrollaufgabeSchema,
  KontrollaufgabenEingabeSchema,
  KontrollaufgabenSchema,
  NachtragErgebnisSchema,
  NachweisAnhaengenBodySchema,
  NachweisEntfernenEingabeSchema,
  NachweisEntferntSchema,
  NachweisErgebnisSchema,
  NachweisLesenEingabeSchema,
  NachweiseJeDokumentPfadSchema,
  NachweiseJeDokumentQuerySchema,
  NachweiseJeDokumentSchema,
} from './bereiche/durchfuehrung';
import {
  AnlageGespeichertSchema,
  EreignisAktionSchema,
  EreignisAnlageLesenSchema,
  EreignisDetailSchema,
  EreignisErfassenBodySchema,
  EreignisErfasstSchema,
  EreignisErgebnisSchema,
  EreignisListeSchema,
  ErklaerungBodySchema,
  ErklaerungErgebnisSchema,
  FeststellungAktionSchema,
  FeststellungDetailSchema,
  FeststellungErfassenBodySchema,
  FeststellungErfasstSchema,
  FeststellungErgebnisSchema,
  FeststellungListeSchema,
  FeststellungWeiterBodySchema,
  FolgeAktionSchema,
  FolgeErgebnisSchema,
  FolgeHinzufuegenBodySchema,
  FolgenAngelegtSchema,
  FolgenAnlegenBodySchema,
  LaenderSchema,
  LandHinzufuegenBodySchema,
  LandStaendeBodySchema,
  LandStaendeErgebnisSchema,
  MassnahmeAktionSchema,
  MassnahmeBodySchema,
  MassnahmeErgebnisSchema,
  MassnahmeErledigenBodySchema,
  NachkontrolleBodySchema,
  NachkontrolleErgebnisSchema,
  P153BodySchema,
  P153ErgebnisSchema,
  PortalMeldungBodySchema,
  PortalMeldungErgebnisSchema,
  PortalMeldungenSchema,
  StandQuerySchema,
  VertraulichBodySchema,
  VertraulichErgebnisSchema,
  VerwerfenAbgelehntSchema,
  VerwerfenBeantragenBodySchema,
  WuerdigungBodySchema,
} from './bereiche/feststellungen-ereignisse';
import {
  ArbeitskorbAntwortSchema,
  AuditListeAntwortSchema,
  AuditPruefenAntwortSchema,
  AuditPruefenEingabeSchema,
  AuditQuerySchema,
  KontakteAntwortSchema,
  KontaktRollenAntwortSchema,
  KontaktRollenBodySchema,
  KontextAntwortSchema,
  KontextQuerySchema,
  MandantAnkerAntwortSchema,
  MandantAnkerBodySchema,
  MandantenListeSchema,
  PortalUebersichtAntwortSchema,
  PortfolioAntwortSchema,
} from './bereiche/lesepfade';
import {
  AbschnittSpeichernBodySchema,
  AbschnittSpeichernErgebnisSchema,
  BeschreibungFreigabeAnfordernBodySchema,
  BeschreibungFreigabeAnfordernErgebnisSchema,
  BeschreibungLesenQuerySchema,
  BeschreibungVersionAktionEingabeSchema,
  BeschreibungVersionAktionErgebnisSchema,
  BeschreibungVersionAnlegenErgebnisSchema,
  BeschreibungViewSchema,
  EinrichtungLesenQuerySchema,
  EinrichtungViewSchema,
  EntwurfSpeichernBodySchema,
  EntwurfSpeichernErgebnisSchema,
  FreigabeNeuadressierungBodySchema,
  FreigabeNeuadressierungErgebnisSchema,
  FreigabePfadSchema,
  FreigabenHistorieQuerySchema,
  FreigabenHistorieSchema,
  NachrichtenOffenQuerySchema,
  NachrichtenOffenSchema,
  NachrichtPfadSchema,
  NachrichtUnzustellbarBodySchema,
  NachrichtUnzustellbarErgebnisSchema,
  NachrichtZugestelltEingabeSchema,
  NachrichtZugestelltErgebnisSchema,
  PortalCodeAnfordernErgebnisSchema,
  PortalFreigabenViewSchema,
  PortalFreigebenBodySchema,
  PortalFreigebenErgebnisSchema,
  PortalKenntnisnahmeBodySchema,
  PortalKenntnisnahmeErgebnisSchema,
  ProgrammAnlegenBodySchema,
  ProgrammAnlegenErgebnisSchema,
  ReviewZurueckweisenBodySchema,
} from './bereiche/programm-beschreibung';
import {
  AbweichungAufhebenBodySchema,
  AbweichungBeantragenBodySchema,
  AbweichungEntscheidenBodySchema,
  DesignBeurteilenBodySchema,
  FreigabeSchrittErgebnisSchema,
  KontrolleDetailSchema,
  KontrolleGeaendertSchema,
  KontrollenListeSchema,
  KontrollePfadSchema,
  NeuBewertungErgebnisSchema,
  ProfilAendernBodySchema,
  ProfilDatenSchema,
  ProfilGeaendertSchema,
  RisikenFreigabeSchrittBodySchema,
  RisikenKontrollenQuerySchema,
  RisikenListeSchema,
  RisikoakzeptanzAngefordertSchema,
  RisikoakzeptanzAnfordernBodySchema,
  RisikoAufgenommenSchema,
  RisikoAufnehmenBodySchema,
  RisikoBestaetigenBodySchema,
  RisikoDetailSchema,
  RisikoNeuBewertenBodySchema,
  RisikoPfadSchema,
  RisikoZurueckgewiesenSchema,
  RisikoZurueckweisenBodySchema,
  UebersteuerungBeantragenBodySchema,
  UebersteuerungBeantragtSchema,
  UebersteuerungEntscheidenBodySchema,
  UebersteuerungEntschiedenSchema,
  UebersteuerungPfadSchema,
  VerantwortlicheAendernBodySchema,
} from './bereiche/risiken-kontrollen';

// -----------------------------------------------------------------------------
// Typen
// -----------------------------------------------------------------------------

export const ENDPUNKT_METHODEN = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type EndpunktMethode = (typeof ENDPUNKT_METHODEN)[number];

/** Ein Endpunkt des Dienstes. `querySchema`/`bodySchema` `null`: keine Query bzw. leerer Body. */
export interface Endpunkt<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType | null = z.ZodType | null,
  B extends z.ZodType | null = z.ZodType | null,
  A extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly methode: EndpunktMethode;
  /** Muster unter `/v1/`, z. B. `/v1/mandanten/:mandantId/risiken/:risikoId`. */
  readonly pfad: string;
  /**
   * Zugelassene Akteursarten (`knd` der Bestätigung, ADR 0001 §3.3, §7); jede
   * andere Art erhält 404. `['SYSTEM']` steht immer allein; leer nur bei
   * `health` (ohne Bestätigung). Eingefroren.
   */
  readonly akteure: readonly AkteurArt[];
  /**
   * Mandantenkontakte zugelassen – abgeleitet: `akteure` enthält `MANDANT`.
   * @deprecated Nur für bestehende Aufrufer; maßgeblich ist `akteure`.
   */
  readonly portal: boolean;
  /** Pfad unter `/v1/mandanten/:mandantId/…`: an `cli.id` gebunden (ADR 0001 §3.3). */
  readonly mandantenbezogen: boolean;
  /** Akteursbestätigung verlangt; `false` nur für `health` (nur Dienst-Token). */
  readonly akteur: boolean;
  /** Strenges Objekt mit genau den Parametern des Musters. */
  readonly paramsSchema: P;
  readonly querySchema: Q;
  readonly bodySchema: B;
  /** Schema von `daten` einer Erfolgsantwort. */
  readonly antwortSchema: A;
  readonly erfolgStatus: 200 | 201;
}

interface Definition {
  methode: EndpunktMethode;
  pfad: string;
  /** Standard: nur Kanzleipersonen (`NUR_KANZLEI`). */
  akteure?: readonly AkteurArt[];
  akteur?: boolean;
  params: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  antwort: z.ZodType;
  status?: 200 | 201;
}

type Oder<T, Ersatz> = T extends z.ZodType ? T : Ersatz;

/** Nur Kanzleipersonen (Standard). */
export const NUR_KANZLEI = Object.freeze(['KANZLEI'] as const);
/** Kanzleipersonen und Mandantenkontakte (nur `/v1/ich`). */
export const KANZLEI_UND_MANDANT = Object.freeze(['KANZLEI', 'MANDANT'] as const);
/** Nur Mandantenkontakte: alle Portal-Endpunkte (`…/portal/…`, Stufe 5). */
export const NUR_MANDANT = Object.freeze(['MANDANT'] as const);
/** Nur der Systemakteur (Dienstnutzer der kanzleikonsole), keine Person. */
export const NUR_SYSTEM = Object.freeze(['SYSTEM'] as const);

type AkteureAus<D extends Definition> = D['akteur'] extends false
  ? readonly []
  : D['akteure'] extends readonly AkteurArt[]
    ? D['akteure']
    : typeof NUR_KANZLEI;

/** Vollständiger Eintrag aus einer Definition; `name` ist der Schlüssel im Register. */
export type EndpunktAus<N extends string, D extends Definition> = Endpunkt<
  D['params'],
  Oder<D['query'], null>,
  Oder<D['body'], null>,
  D['antwort']
> & {
  readonly name: N;
  readonly methode: D['methode'];
  readonly pfad: D['pfad'];
  readonly akteure: AkteureAus<D>;
};

const MANDANT_PFAD = '/v1/mandanten/:mandantId';
const PORTAL_PFAD = `${MANDANT_PFAD}/portal/`;
const ICH_PFAD = '/v1/ich';

/**
 * Zugelassene Akteursarten einer Definition, geprüft (fail closed): bekannte
 * Arten ohne Doppelte, mindestens eine (außer `health`), der Systemakteur nur
 * allein und nie auf Mandantenpfaden (er hat kein `cli`). Wirft beim Laden
 * des Vertrags – ein falsch definierter Endpunkt erreicht weder Dienst noch
 * kanzleikonsole.
 */
export function pruefeAkteure(
  name: string,
  pfad: string,
  akteur: boolean,
  akteure: readonly unknown[] | undefined,
): readonly AkteurArt[] {
  if (!akteur) {
    if (akteure !== undefined && akteure.length > 0) {
      throw new Error(`Endpunkt ${name}: ohne Bestätigung keine Akteursarten`);
    }
    return Object.freeze([]);
  }
  const arten = akteure ?? NUR_KANZLEI;
  if (!Array.isArray(arten) || arten.length === 0) {
    throw new Error(`Endpunkt ${name}: mindestens eine Akteursart`);
  }
  for (const a of arten) {
    if (!(AKTEUR_ARTEN as readonly unknown[]).includes(a)) {
      throw new Error(`Endpunkt ${name}: unbekannte Akteursart`);
    }
  }
  if (new Set(arten).size !== arten.length) {
    throw new Error(`Endpunkt ${name}: Akteursart doppelt`);
  }
  if (arten.includes('SYSTEM')) {
    if (arten.length !== 1) throw new Error(`Endpunkt ${name}: SYSTEM nur allein`);
    if (pfad.startsWith(MANDANT_PFAD)) {
      throw new Error(`Endpunkt ${name}: SYSTEM nicht auf Mandantenpfaden`);
    }
  }
  return Object.freeze([...(arten as AkteurArt[])]);
}

/**
 * Portal-Regel des Registers (Stufe 5, fail closed): Portal-Pfade
 * (`/v1/mandanten/:mandantId/portal/…`) lassen genau Mandantenkontakte zu –
 * Kanzleipersonen lesen und schreiben über ihre eigenen Endpunkte, ein
 * Portal-Endpunkt nimmt sie nie an (404). Mandantenkontakte erreichen nur
 * Portal-Pfade und `/v1/ich`. Gilt für jeden Registereintrag; der Dienst
 * registriert nur Routen aus dem Register.
 */
export function pruefePortal(name: string, pfad: string, akteure: readonly AkteurArt[]): void {
  const portalPfad = pfad.startsWith(PORTAL_PFAD);
  if (portalPfad && !(akteure.length === 1 && akteure[0] === 'MANDANT')) {
    throw new Error(`Endpunkt ${name}: Portal-Pfade nur für MANDANT`);
  }
  if (!portalPfad && pfad !== ICH_PFAD && akteure.includes('MANDANT')) {
    throw new Error(`Endpunkt ${name}: MANDANT nur auf Portal-Pfaden und ${ICH_PFAD}`);
  }
}

function register<const D extends Record<string, Definition>>(
  definitionen: D,
): { readonly [N in keyof D & string]: EndpunktAus<N, D[N]> } {
  const eintraege = Object.entries(definitionen).map(([name, d]) => {
    const akteur = d.akteur ?? true;
    const akteure = pruefeAkteure(name, d.pfad, akteur, d.akteure);
    pruefePortal(name, d.pfad, akteure);
    const eintrag: Endpunkt = {
      name,
      methode: d.methode,
      pfad: d.pfad,
      akteure,
      portal: akteure.includes('MANDANT'),
      mandantenbezogen: d.pfad.startsWith(MANDANT_PFAD),
      akteur,
      paramsSchema: d.params,
      querySchema: d.query ?? null,
      bodySchema: d.body ?? null,
      antwortSchema: d.antwort,
      erfolgStatus: d.status ?? 200,
    };
    return [name, Object.freeze(eintrag)] as const;
  });
  return Object.freeze(Object.fromEntries(eintraege)) as {
    readonly [N in keyof D & string]: EndpunktAus<N, D[N]>;
  };
}

// -----------------------------------------------------------------------------
// Schemas ohne eigenen Bereich
// -----------------------------------------------------------------------------

/** Endpunkte ohne Pfadparameter. */
export const KeineParamsSchema = z.object({}).strict();
/** Endpunkte, deren einziger Pfadparameter der Mandant ist. */
export const MandantPfadSchema = z.object({ mandantId: z.uuid() }).strict();

/** `GET /v1/health` (nur Dienst-Token, ADR 0001 §7). */
export const HealthAntwortSchema = z
  .object({ version: z.string().min(1).max(100), datenbank: z.enum(['ok', 'fehler']) })
  .strict();
export type HealthAntwort = z.infer<typeof HealthAntwortSchema>;

/** `GET /v1/ich`: der aus der Bestätigung abgeleitete `Akteur` (Vertragstest). */
export const IchAntwortSchema = z.discriminatedUnion('art', [
  z
    .object({
      art: z.literal('KANZLEI'),
      tenantId: z.uuid(),
      id: z.uuid(),
      name: z.string().min(1).max(200),
      istAdmin: z.boolean(),
      istBerufstraeger: z.boolean(),
      mandant: z
        .object({
          id: z.uuid(),
          zustaendigBerufstraeger: z.boolean(),
          hauptbearbeitung: z.boolean(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      art: z.literal('MANDANT'),
      tenantId: z.uuid(),
      id: z.uuid(),
      name: z.string().min(1).max(200),
      mandantId: z.uuid(),
    })
    .strict(),
]);
export type IchAntwort = z.infer<typeof IchAntwortSchema>;

// -----------------------------------------------------------------------------
// Register
// -----------------------------------------------------------------------------

const M = '/v1/mandanten/:mandantId';
/** Kontrolldurchführung der Kanzlei. */
const D = `${M}/durchfuehrungen/:durchfuehrungId`;
/** Kontrollaufgaben im Portal. */
const P = `${M}/portal/aufgaben`;
const F = `${M}/feststellungen/:feststellungId`;
const E = `${M}/ereignisse/:ereignisId`;
const VERSION = `${M}/beschreibung/versionen/:versionId`;
const FREIGABE = `${M}/portal/freigaben/:freigabeId`;

export const ENDPUNKTE = register({
  // ---- Dienst -------------------------------------------------------------
  health: {
    methode: 'GET',
    pfad: '/v1/health',
    akteur: false,
    params: KeineParamsSchema,
    antwort: HealthAntwortSchema,
  },
  ich: {
    methode: 'GET',
    pfad: '/v1/ich',
    akteure: KANZLEI_UND_MANDANT,
    params: KeineParamsSchema,
    antwort: IchAntwortSchema,
  },

  // ---- Lesepfade und Verwaltung -------------------------------------------
  kontextLesen: {
    methode: 'GET',
    pfad: `${M}/kontext`,
    params: MandantPfadSchema,
    query: KontextQuerySchema,
    antwort: KontextAntwortSchema,
  },
  mandantAnkerSetzen: {
    methode: 'PUT',
    pfad: M,
    params: MandantPfadSchema,
    body: MandantAnkerBodySchema,
    antwort: MandantAnkerAntwortSchema,
  },
  kontakteLesen: {
    methode: 'GET',
    pfad: `${M}/kontakte`,
    params: MandantPfadSchema,
    antwort: KontakteAntwortSchema,
  },
  kontaktRollenSetzen: {
    methode: 'PUT',
    pfad: `${M}/kontakte`,
    params: MandantPfadSchema,
    body: KontaktRollenBodySchema,
    antwort: KontaktRollenAntwortSchema,
  },
  portalUebersichtLesen: {
    methode: 'GET',
    pfad: `${M}/portal/uebersicht`,
    akteure: NUR_MANDANT,
    params: MandantPfadSchema,
    antwort: PortalUebersichtAntwortSchema,
  },
  portfolioLesen: {
    methode: 'POST',
    pfad: '/v1/portfolio',
    params: KeineParamsSchema,
    body: MandantenListeSchema,
    antwort: PortfolioAntwortSchema,
  },
  arbeitskorbLesen: {
    methode: 'POST',
    pfad: '/v1/arbeitskorb',
    params: KeineParamsSchema,
    body: MandantenListeSchema,
    antwort: ArbeitskorbAntwortSchema,
  },
  auditLesen: {
    methode: 'GET',
    pfad: '/v1/audit',
    params: KeineParamsSchema,
    query: AuditQuerySchema,
    antwort: AuditListeAntwortSchema,
  },
  auditPruefen: {
    methode: 'POST',
    pfad: '/v1/audit/pruefen',
    params: KeineParamsSchema,
    body: AuditPruefenEingabeSchema,
    antwort: AuditPruefenAntwortSchema,
  },

  // ---- Kontrolldurchführung (Kanzlei) --------------------------------------
  durchfuehrungLesen: {
    methode: 'GET',
    pfad: D,
    params: DurchfuehrungZielSchema,
    query: DurchfuehrungStandQuerySchema,
    antwort: DurchfuehrungDetailSchema,
  },
  durchfuehrungBeginnen: {
    methode: 'POST',
    pfad: `${D}/beginnen`,
    params: DurchfuehrungZielSchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  durchfuehrungSpeichern: {
    methode: 'POST',
    pfad: `${D}/speichern`,
    params: DurchfuehrungZielSchema,
    body: DurchfuehrungSpeichernBodySchema,
    antwort: DurchfuehrungSpeichernErgebnisSchema,
  },
  durchfuehrungEinreichen: {
    methode: 'POST',
    pfad: `${D}/einreichen`,
    params: DurchfuehrungZielSchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  nachweisAnhaengen: {
    methode: 'POST',
    pfad: `${D}/nachweise`,
    params: DurchfuehrungZielSchema,
    body: NachweisAnhaengenBodySchema,
    antwort: NachweisErgebnisSchema,
    status: 201,
  },
  nachweisEntfernen: {
    methode: 'POST',
    pfad: `${D}/nachweise/:nachweisId/entfernen`,
    params: NachweisEntfernenEingabeSchema,
    antwort: NachweisEntferntSchema,
  },
  durchfuehrungZurueckweisen: {
    methode: 'POST',
    pfad: `${D}/zurueckweisen`,
    params: DurchfuehrungZielSchema,
    body: DurchfuehrungBegruendungBodySchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  durchfuehrungGegenzeichnen: {
    methode: 'POST',
    pfad: `${D}/gegenzeichnen`,
    params: DurchfuehrungZielSchema,
    body: GegenzeichnenBodySchema,
    antwort: GegenzeichnenErgebnisSchema,
  },
  entfallenBeantragen: {
    methode: 'POST',
    pfad: `${D}/entfallen/beantragen`,
    params: DurchfuehrungZielSchema,
    body: DurchfuehrungBegruendungBodySchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  entfallenFreigeben: {
    methode: 'POST',
    pfad: `${D}/entfallen/freigeben`,
    params: DurchfuehrungZielSchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  entfallenAblehnen: {
    methode: 'POST',
    pfad: `${D}/entfallen/ablehnen`,
    params: DurchfuehrungZielSchema,
    body: EntfallenAblehnenBodySchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  nachtragAnlegen: {
    methode: 'POST',
    pfad: `${D}/nachtrag`,
    params: DurchfuehrungZielSchema,
    body: DurchfuehrungBegruendungBodySchema,
    antwort: NachtragErgebnisSchema,
    status: 201,
  },
  nachweisLesen: {
    methode: 'GET',
    pfad: `${M}/nachweise/:nachweisId`,
    params: NachweisLesenEingabeSchema,
    antwort: NachweisErgebnisSchema,
  },
  /** Nachweise je Dokument-ID (Abgleich der kanzleikonsole), auch entfernte; nur Kanzlei. */
  nachweiseJeDokumentLesen: {
    methode: 'GET',
    pfad: `${M}/nachweise`,
    params: NachweiseJeDokumentPfadSchema,
    query: NachweiseJeDokumentQuerySchema,
    antwort: NachweiseJeDokumentSchema,
  },

  // ---- Kontrollaufgaben (Portal) -------------------------------------------
  portalAufgabenLesen: {
    methode: 'GET',
    pfad: P,
    akteure: NUR_MANDANT,
    params: KontrollaufgabenEingabeSchema,
    antwort: KontrollaufgabenSchema,
  },
  portalAufgabeLesen: {
    methode: 'GET',
    pfad: `${P}/:durchfuehrungId`,
    akteure: NUR_MANDANT,
    params: DurchfuehrungZielSchema,
    query: DurchfuehrungStandQuerySchema,
    antwort: KontrollaufgabeSchema,
  },
  portalAufgabeSpeichern: {
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/speichern`,
    akteure: NUR_MANDANT,
    params: DurchfuehrungZielSchema,
    body: DurchfuehrungSpeichernBodySchema,
    antwort: DurchfuehrungSpeichernErgebnisSchema,
  },
  portalAufgabeEinreichen: {
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/einreichen`,
    akteure: NUR_MANDANT,
    params: DurchfuehrungZielSchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  portalAnlageAnhaengen: {
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/anlagen`,
    akteure: NUR_MANDANT,
    params: DurchfuehrungZielSchema,
    body: NachweisAnhaengenBodySchema,
    antwort: NachweisErgebnisSchema,
    status: 201,
  },
  portalAnlageEntfernen: {
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/anlagen/:nachweisId/entfernen`,
    akteure: NUR_MANDANT,
    params: NachweisEntfernenEingabeSchema,
    antwort: NachweisEntferntSchema,
  },
  portalAufgabeZurueckgeben: {
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/zurueckgeben`,
    akteure: NUR_MANDANT,
    params: DurchfuehrungZielSchema,
    body: DurchfuehrungBegruendungBodySchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  portalAufgabeBestaetigen: {
    methode: 'POST',
    pfad: `${P}/:durchfuehrungId/bestaetigen`,
    akteure: NUR_MANDANT,
    params: DurchfuehrungZielSchema,
    antwort: DurchfuehrungUebergangSchema,
  },
  portalAnlageLesen: {
    methode: 'GET',
    pfad: `${M}/portal/anlagen/:nachweisId`,
    akteure: NUR_MANDANT,
    params: NachweisLesenEingabeSchema,
    antwort: NachweisErgebnisSchema,
  },

  // ---- Risikoinventar --------------------------------------------------------
  risikenLesen: {
    methode: 'GET',
    pfad: `${M}/risiken`,
    params: MandantPfadSchema,
    query: RisikenKontrollenQuerySchema,
    antwort: RisikenListeSchema,
  },
  risikoLesen: {
    methode: 'GET',
    pfad: `${M}/risiken/:risikoId`,
    params: RisikoPfadSchema,
    query: RisikenKontrollenQuerySchema,
    antwort: RisikoDetailSchema,
  },
  risikoNeuBewerten: {
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/neu-bewerten`,
    params: RisikoPfadSchema,
    body: RisikoNeuBewertenBodySchema,
    antwort: NeuBewertungErgebnisSchema,
  },
  risikoBewertungBestaetigen: {
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/bewertung-bestaetigen`,
    params: RisikoPfadSchema,
    body: RisikoBestaetigenBodySchema,
    antwort: NeuBewertungErgebnisSchema,
  },
  uebersteuerungBeantragen: {
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/uebersteuerungen`,
    params: RisikoPfadSchema,
    body: UebersteuerungBeantragenBodySchema,
    antwort: UebersteuerungBeantragtSchema,
    status: 201,
  },
  uebersteuerungEntscheiden: {
    methode: 'POST',
    pfad: `${M}/uebersteuerungen/:uebersteuerungId/entscheiden`,
    params: UebersteuerungPfadSchema,
    body: UebersteuerungEntscheidenBodySchema,
    antwort: UebersteuerungEntschiedenSchema,
  },
  risikenFreigabeEinreichen: {
    methode: 'POST',
    pfad: `${M}/risiken-freigabe/einreichen`,
    params: MandantPfadSchema,
    body: RisikenFreigabeSchrittBodySchema,
    antwort: FreigabeSchrittErgebnisSchema,
  },
  risikenFreigeben: {
    methode: 'POST',
    pfad: `${M}/risiken-freigabe/freigeben`,
    params: MandantPfadSchema,
    body: RisikenFreigabeSchrittBodySchema,
    antwort: FreigabeSchrittErgebnisSchema,
  },
  risikoZurueckweisen: {
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/zurueckweisen`,
    params: RisikoPfadSchema,
    body: RisikoZurueckweisenBodySchema,
    antwort: RisikoZurueckgewiesenSchema,
  },
  risikoakzeptanzAnfordern: {
    methode: 'POST',
    pfad: `${M}/risiken/:risikoId/akzeptanz-anfordern`,
    params: RisikoPfadSchema,
    body: RisikoakzeptanzAnfordernBodySchema,
    antwort: RisikoakzeptanzAngefordertSchema,
    status: 201,
  },

  // ---- Kontrollmatrix --------------------------------------------------------
  kontrollenLesen: {
    methode: 'GET',
    pfad: `${M}/kontrollen`,
    params: MandantPfadSchema,
    query: RisikenKontrollenQuerySchema,
    antwort: KontrollenListeSchema,
  },
  kontrolleLesen: {
    methode: 'GET',
    pfad: `${M}/kontrollen/:kontrolleId`,
    params: KontrollePfadSchema,
    query: RisikenKontrollenQuerySchema,
    antwort: KontrolleDetailSchema,
  },
  kontrolleDesignBeurteilen: {
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/design`,
    params: KontrollePfadSchema,
    body: DesignBeurteilenBodySchema,
    antwort: KontrolleGeaendertSchema,
  },
  frequenzAbweichungBeantragen: {
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/abweichung`,
    params: KontrollePfadSchema,
    body: AbweichungBeantragenBodySchema,
    antwort: KontrolleGeaendertSchema,
  },
  frequenzAbweichungEntscheiden: {
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/abweichung/entscheiden`,
    params: KontrollePfadSchema,
    body: AbweichungEntscheidenBodySchema,
    antwort: KontrolleGeaendertSchema,
  },
  frequenzAbweichungAufheben: {
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/abweichung/aufheben`,
    params: KontrollePfadSchema,
    body: AbweichungAufhebenBodySchema,
    antwort: KontrolleGeaendertSchema,
  },
  verantwortlicheAendern: {
    methode: 'POST',
    pfad: `${M}/kontrollen/:kontrolleId/verantwortliche`,
    params: KontrollePfadSchema,
    body: VerantwortlicheAendernBodySchema,
    antwort: KontrolleGeaendertSchema,
  },

  // ---- Geschäftsprofil -------------------------------------------------------
  profilLesen: {
    methode: 'GET',
    pfad: `${M}/profil`,
    params: MandantPfadSchema,
    query: RisikenKontrollenQuerySchema,
    antwort: ProfilDatenSchema,
  },
  profilAendern: {
    methode: 'POST',
    pfad: `${M}/profil`,
    params: MandantPfadSchema,
    body: ProfilAendernBodySchema,
    antwort: ProfilGeaendertSchema,
  },
  profilRisikoAufnehmen: {
    methode: 'POST',
    pfad: `${M}/profil/risiko-aufnehmen`,
    params: MandantPfadSchema,
    body: RisikoAufnehmenBodySchema,
    antwort: RisikoAufgenommenSchema,
    status: 201,
  },

  // ---- Feststellungen und Maßnahmen ----------------------------------------
  feststellungenLesen: {
    methode: 'GET',
    pfad: `${M}/feststellungen`,
    params: MandantPfadSchema,
    query: StandQuerySchema,
    antwort: FeststellungListeSchema,
  },
  feststellungLesen: {
    methode: 'GET',
    pfad: F,
    params: FeststellungAktionSchema,
    query: StandQuerySchema,
    antwort: FeststellungDetailSchema,
  },
  feststellungErfassen: {
    methode: 'POST',
    pfad: `${M}/feststellungen`,
    params: MandantPfadSchema,
    body: FeststellungErfassenBodySchema,
    antwort: FeststellungErfasstSchema,
    status: 201,
  },
  feststellungWeiterschalten: {
    methode: 'POST',
    pfad: `${F}/weiter`,
    params: FeststellungAktionSchema,
    body: FeststellungWeiterBodySchema,
    antwort: FeststellungErgebnisSchema,
  },
  p153Entscheiden: {
    methode: 'POST',
    pfad: `${F}/p153`,
    params: FeststellungAktionSchema,
    body: P153BodySchema,
    antwort: P153ErgebnisSchema,
  },
  wuerdigungAktualisieren: {
    methode: 'POST',
    pfad: `${F}/wuerdigung`,
    params: FeststellungAktionSchema,
    body: WuerdigungBodySchema,
    antwort: FeststellungErgebnisSchema,
  },
  erklaerungHinzufuegen: {
    methode: 'POST',
    pfad: `${F}/erklaerungen`,
    params: FeststellungAktionSchema,
    body: ErklaerungBodySchema,
    antwort: ErklaerungErgebnisSchema,
    status: 201,
  },
  massnahmeAnlegen: {
    methode: 'POST',
    pfad: `${F}/massnahmen`,
    params: FeststellungAktionSchema,
    body: MassnahmeBodySchema,
    antwort: MassnahmeErgebnisSchema,
    status: 201,
  },
  nachkontrolleAnlegen: {
    methode: 'POST',
    pfad: `${F}/nachkontrolle`,
    params: FeststellungAktionSchema,
    body: NachkontrolleBodySchema,
    antwort: NachkontrolleErgebnisSchema,
    status: 201,
  },
  feststellungVerwerfenBeantragen: {
    methode: 'POST',
    pfad: `${F}/verwerfen/beantragen`,
    params: FeststellungAktionSchema,
    body: VerwerfenBeantragenBodySchema,
    antwort: FeststellungErgebnisSchema,
  },
  feststellungVerwerfenBestaetigen: {
    methode: 'POST',
    pfad: `${F}/verwerfen/bestaetigen`,
    params: FeststellungAktionSchema,
    antwort: FeststellungErgebnisSchema,
  },
  feststellungVerwerfenAblehnen: {
    methode: 'POST',
    pfad: `${F}/verwerfen/ablehnen`,
    params: FeststellungAktionSchema,
    antwort: VerwerfenAbgelehntSchema,
  },
  feststellungVertraulichSetzen: {
    methode: 'POST',
    pfad: `${F}/vertraulich`,
    params: FeststellungAktionSchema,
    body: VertraulichBodySchema,
    antwort: VertraulichErgebnisSchema,
  },
  massnahmeErledigen: {
    methode: 'POST',
    pfad: `${M}/massnahmen/:massnahmeId/erledigen`,
    params: MassnahmeAktionSchema,
    body: MassnahmeErledigenBodySchema,
    antwort: MassnahmeErgebnisSchema,
  },

  // ---- Ereignisse -------------------------------------------------------------
  ereignisseLesen: {
    methode: 'GET',
    pfad: `${M}/ereignisse`,
    params: MandantPfadSchema,
    query: StandQuerySchema,
    antwort: EreignisListeSchema,
  },
  ereignisLesen: {
    methode: 'GET',
    pfad: E,
    params: EreignisAktionSchema,
    query: StandQuerySchema,
    antwort: EreignisDetailSchema,
  },
  ereignisAnlageLesen: {
    methode: 'GET',
    pfad: `${E}/anlagen/:sha256`,
    params: EreignisAnlageLesenSchema,
    antwort: AnlageGespeichertSchema,
  },
  ereignisErfassen: {
    methode: 'POST',
    pfad: `${M}/ereignisse`,
    params: MandantPfadSchema,
    body: EreignisErfassenBodySchema,
    antwort: EreignisErfasstSchema,
    status: 201,
  },
  ereignisInPruefungNehmen: {
    methode: 'POST',
    pfad: `${E}/in-pruefung`,
    params: EreignisAktionSchema,
    antwort: EreignisErgebnisSchema,
  },
  folgeHinzufuegen: {
    methode: 'POST',
    pfad: `${E}/folgen`,
    params: EreignisAktionSchema,
    body: FolgeHinzufuegenBodySchema,
    antwort: FolgeErgebnisSchema,
    status: 201,
  },
  folgenAnlegen: {
    methode: 'POST',
    pfad: `${E}/folgen/anlegen`,
    params: EreignisAktionSchema,
    body: FolgenAnlegenBodySchema,
    antwort: FolgenAngelegtSchema,
  },
  folgeErledigen: {
    methode: 'POST',
    pfad: `${E}/folgen/:folgeId/erledigen`,
    params: FolgeAktionSchema,
    antwort: FolgeErgebnisSchema,
  },
  folgeVerwerfen: {
    methode: 'POST',
    pfad: `${E}/folgen/:folgeId/verwerfen`,
    params: FolgeAktionSchema,
    body: VerwerfenBeantragenBodySchema,
    antwort: FolgeErgebnisSchema,
  },
  ereignisAbschliessen: {
    methode: 'POST',
    pfad: `${E}/abschliessen`,
    params: EreignisAktionSchema,
    antwort: EreignisErgebnisSchema,
  },
  ereignisVerwerfenBeantragen: {
    methode: 'POST',
    pfad: `${E}/verwerfen/beantragen`,
    params: EreignisAktionSchema,
    body: VerwerfenBeantragenBodySchema,
    antwort: EreignisErgebnisSchema,
  },
  ereignisVerwerfenBestaetigen: {
    methode: 'POST',
    pfad: `${E}/verwerfen/bestaetigen`,
    params: EreignisAktionSchema,
    antwort: EreignisErgebnisSchema,
  },
  ereignisVerwerfenAblehnen: {
    methode: 'POST',
    pfad: `${E}/verwerfen/ablehnen`,
    params: EreignisAktionSchema,
    antwort: VerwerfenAbgelehntSchema,
  },
  portalMeldungenLesen: {
    methode: 'GET',
    pfad: `${M}/portal/ereignisse`,
    akteure: NUR_MANDANT,
    params: MandantPfadSchema,
    antwort: PortalMeldungenSchema,
  },
  portalMeldungErfassen: {
    methode: 'POST',
    pfad: `${M}/portal/ereignisse`,
    akteure: NUR_MANDANT,
    params: MandantPfadSchema,
    body: PortalMeldungBodySchema,
    antwort: PortalMeldungErgebnisSchema,
    status: 201,
  },

  // ---- Länder-Monitor ---------------------------------------------------------
  laenderLesen: {
    methode: 'GET',
    pfad: `${M}/laender`,
    params: MandantPfadSchema,
    query: StandQuerySchema,
    antwort: LaenderSchema,
  },
  landHinzufuegen: {
    methode: 'POST',
    pfad: `${M}/laender`,
    params: MandantPfadSchema,
    body: LandHinzufuegenBodySchema,
    antwort: LandStaendeErgebnisSchema,
    status: 201,
  },
  landStaendeSpeichern: {
    methode: 'POST',
    pfad: `${M}/laender/staende`,
    params: MandantPfadSchema,
    body: LandStaendeBodySchema,
    antwort: LandStaendeErgebnisSchema,
    status: 201,
  },

  // ---- Postausgang (tenantweit, nur Systemakteur: Zustell-Worker der kanzleikonsole) ----
  nachrichtenOffenLesen: {
    methode: 'GET',
    pfad: '/v1/nachrichten/offen',
    akteure: NUR_SYSTEM,
    params: KeineParamsSchema,
    query: NachrichtenOffenQuerySchema,
    antwort: NachrichtenOffenSchema,
  },
  nachrichtZugestelltMelden: {
    methode: 'POST',
    pfad: '/v1/nachrichten/:nachrichtId/zugestellt',
    akteure: NUR_SYSTEM,
    params: NachrichtZugestelltEingabeSchema,
    antwort: NachrichtZugestelltErgebnisSchema,
  },
  nachrichtUnzustellbarMelden: {
    methode: 'POST',
    pfad: '/v1/nachrichten/:nachrichtId/unzustellbar',
    akteure: NUR_SYSTEM,
    params: NachrichtPfadSchema,
    body: NachrichtUnzustellbarBodySchema,
    antwort: NachrichtUnzustellbarErgebnisSchema,
  },

  // ---- Einrichtungsassistent --------------------------------------------------
  einrichtungLesen: {
    methode: 'GET',
    pfad: `${M}/einrichtung`,
    params: MandantPfadSchema,
    query: EinrichtungLesenQuerySchema,
    antwort: EinrichtungViewSchema,
  },
  einrichtungEntwurfSpeichern: {
    methode: 'POST',
    pfad: `${M}/einrichtung/entwurf`,
    params: MandantPfadSchema,
    body: EntwurfSpeichernBodySchema,
    antwort: EntwurfSpeichernErgebnisSchema,
  },
  programmAnlegen: {
    methode: 'POST',
    pfad: `${M}/einrichtung/anlegen`,
    params: MandantPfadSchema,
    body: ProgrammAnlegenBodySchema,
    antwort: ProgrammAnlegenErgebnisSchema,
    status: 201,
  },

  // ---- CMS-Beschreibung -------------------------------------------------------
  beschreibungLesen: {
    methode: 'GET',
    pfad: `${M}/beschreibung`,
    params: MandantPfadSchema,
    query: BeschreibungLesenQuerySchema,
    antwort: BeschreibungViewSchema,
  },
  beschreibungsversionAnlegen: {
    methode: 'POST',
    pfad: `${M}/beschreibung/versionen`,
    params: MandantPfadSchema,
    antwort: BeschreibungVersionAnlegenErgebnisSchema,
    status: 201,
  },
  beschreibungsabschnittSpeichern: {
    methode: 'POST',
    pfad: `${VERSION}/abschnitte`,
    params: BeschreibungVersionAktionEingabeSchema,
    body: AbschnittSpeichernBodySchema,
    antwort: AbschnittSpeichernErgebnisSchema,
  },
  beschreibungZurReviewGeben: {
    methode: 'POST',
    pfad: `${VERSION}/review`,
    params: BeschreibungVersionAktionEingabeSchema,
    antwort: BeschreibungVersionAktionErgebnisSchema,
  },
  beschreibungsreviewAbschliessen: {
    methode: 'POST',
    pfad: `${VERSION}/review/abschliessen`,
    params: BeschreibungVersionAktionEingabeSchema,
    antwort: BeschreibungVersionAktionErgebnisSchema,
  },
  beschreibungsreviewZurueckweisen: {
    methode: 'POST',
    pfad: `${VERSION}/review/zurueckweisen`,
    params: BeschreibungVersionAktionEingabeSchema,
    body: ReviewZurueckweisenBodySchema,
    antwort: BeschreibungVersionAktionErgebnisSchema,
  },
  beschreibungsfreigabeAnfordern: {
    methode: 'POST',
    pfad: `${VERSION}/freigabe`,
    params: BeschreibungVersionAktionEingabeSchema,
    body: BeschreibungFreigabeAnfordernBodySchema,
    antwort: BeschreibungFreigabeAnfordernErgebnisSchema,
    status: 201,
  },

  // ---- Freigaben ----------------------------------------------------------------
  freigabeNeuadressieren: {
    methode: 'POST',
    pfad: `${M}/freigaben/:freigabeId/neuadressierung`,
    params: FreigabePfadSchema,
    body: FreigabeNeuadressierungBodySchema,
    antwort: FreigabeNeuadressierungErgebnisSchema,
  },
  portalFreigabenLesen: {
    methode: 'GET',
    pfad: `${M}/portal/freigaben`,
    akteure: NUR_MANDANT,
    params: MandantPfadSchema,
    antwort: PortalFreigabenViewSchema,
  },
  portalFreigabeCodeAnfordern: {
    methode: 'POST',
    pfad: `${FREIGABE}/code`,
    akteure: NUR_MANDANT,
    params: FreigabePfadSchema,
    antwort: PortalCodeAnfordernErgebnisSchema,
  },
  portalFreigabeErteilen: {
    methode: 'POST',
    pfad: `${FREIGABE}/freigeben`,
    akteure: NUR_MANDANT,
    params: FreigabePfadSchema,
    body: PortalFreigebenBodySchema,
    antwort: PortalFreigebenErgebnisSchema,
  },
  portalKenntnisnahmeBestaetigen: {
    methode: 'POST',
    pfad: `${FREIGABE}/kenntnisnahme`,
    akteure: NUR_MANDANT,
    params: FreigabePfadSchema,
    body: PortalKenntnisnahmeBodySchema,
    antwort: PortalKenntnisnahmeErgebnisSchema,
  },

  // ---- Kommunikation --------------------------------------------------------------
  freigabenHistorieLesen: {
    methode: 'GET',
    pfad: `${M}/kommunikation/freigaben`,
    params: MandantPfadSchema,
    query: FreigabenHistorieQuerySchema,
    antwort: FreigabenHistorieSchema,
  },
});

export type EndpunktName = keyof typeof ENDPUNKTE;

/** Alle Endpunkte in Registerreihenfolge. */
export const ENDPUNKT_LISTE: readonly Endpunkt[] = Object.freeze(Object.values(ENDPUNKTE));
