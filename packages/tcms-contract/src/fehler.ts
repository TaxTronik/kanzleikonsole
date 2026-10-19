// =============================================================================
// Antwortumschlag und Fehlercodes des HTTP-Vertrags (ADR 0001, Abschnitt 7).
// =============================================================================

import { z } from 'zod';

export const FEHLER_STATUS = {
  UNGUELTIG: 400,
  NICHT_AUTHENTIFIZIERT: 401,
  NICHT_BERECHTIGT: 403,
  NICHT_GEFUNDEN: 404,
  /** Pfad bekannt, Methode nicht (auch OPTIONS/HEAD); Antwort mit `Allow`. */
  METHODE_NICHT_ERLAUBT: 405,
  KONFLIKT: 409,
  ZU_GROSS: 413,
  INTERN: 500,
} as const;

export type FehlerCode = keyof typeof FEHLER_STATUS;

/**
 * Maschinenlesbarer Grund eines `403 NICHT_BERECHTIGT` (feste Liste, nie
 * Freitext): Die kanzleikonsole wählt danach ihre feste Meldung, statt sie je
 * Aktion zu raten. Je Wert die Rechtefunktion in `@tcms/service` (rechte.ts),
 * deren Ablehnung ihn ergibt:
 *
 *   BEARBEITEN         `kannBearbeiten` (Admin, zuständige:r BT oder
 *                      Hauptbearbeitung; auch wo zusätzlich die zuständige bzw.
 *                      verantwortliche Person handeln darf)
 *   WUERDIGEN          `kannWuerdigen` (§ 153: zuständige:r Berufsträger:in)
 *   VIER_AUGEN         `zweitePerson` bzw. Beteiligte: dieselbe Person darf nicht
 *                      beantragen bzw. mitwirken und entscheiden
 *   VERWALTUNG         `kannVerwalten` (Admin/Partner, kanzleiweit)
 *   VERTRAULICH        `kannVertraulichLesen` (vertrauliche Feststellung, nur
 *                      Beteiligte)
 *   DURCHFUEHREN       `kannDurchfuehren` (zugewiesene Person oder Vertretung)
 *   GEGENZEICHNEN      `kannGegenzeichnen` (zugewiesene Gegenzeichnung oder
 *                      zuständige:r Berufsträger:in)
 *   PARTEI             Schritt der anderen Seite (Kanzlei bzw. Mandant), z. B.
 *                      eine Kontrolle, die der Mandant im Portal durchführt
 *   PORTAL_ROLLE       Rolle beim Mandanten fehlt (`kannPortalLesen`,
 *                      `istGesetzlicherVertreter`: GV bzw. GV/TCB)
 *   PORTAL_ZUGEORDNET  Portal: Aufgabe, Freigabe oder Kenntnisnahme ist einer
 *                      anderen Person zugeordnet
 *
 * Nur für sichtbare Objekte: Was der Akteur nicht sehen darf (fremder Tenant,
 * fremder Mandant, unbekannte ID), ist `NICHT_GEFUNDEN` und trägt nie einen
 * Grund (kein Existenz-Orakel, ADR 0001 §3.3).
 */
export const VERWEIGERUNG_GRUENDE = [
  'BEARBEITEN',
  'WUERDIGEN',
  'VIER_AUGEN',
  'VERWALTUNG',
  'VERTRAULICH',
  'DURCHFUEHREN',
  'GEGENZEICHNEN',
  'PARTEI',
  'PORTAL_ROLLE',
  'PORTAL_ZUGEORDNET',
] as const;

export type VerweigerungGrund = (typeof VERWEIGERUNG_GRUENDE)[number];

/**
 * Fehler im Antwortumschlag. `grund` steht genau bei `NICHT_BERECHTIGT`
 * (dort Pflicht) und fehlt bei jedem anderen Code.
 */
export const FehlerSchema = z
  .object({
    code: z.enum(Object.keys(FEHLER_STATUS) as [FehlerCode, ...FehlerCode[]]),
    meldung: z.string().max(500).optional(),
    felder: z.record(z.string(), z.array(z.string().max(300)).max(20)).optional(),
    grund: z.enum(VERWEIGERUNG_GRUENDE).optional(),
  })
  .strict()
  .refine((f) => (f.code === 'NICHT_BERECHTIGT') === (f.grund !== undefined), {
    message: 'grund genau bei NICHT_BERECHTIGT',
    path: ['grund'],
  });

export type Fehler = z.infer<typeof FehlerSchema>;

export type Antwort<T> = { ok: true; daten: T } | { ok: false; fehler: Fehler };

export function antwortSchema<T extends z.ZodType>(daten: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), daten }).strict(),
    z.object({ ok: z.literal(false), fehler: FehlerSchema }).strict(),
  ]);
}

/** Höchste Größe eines Anfrage-Bodys in Bytes. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Höchste Zahl Mandanten-IDs in mandantenübergreifenden Lesepfaden. */
export const MAX_MANDANTEN_JE_ANFRAGE = 5000;

/**
 * Fachlicher bzw. technischer Fehler, den der Dienst in den Antwortumschlag
 * übersetzt. Meldungen sind für Nutzer bestimmt und enthalten keine internen
 * Details (keine IDs fremder Mandanten, keine SQL-Fehler).
 *
 * `NICHT_BERECHTIGT` entsteht nur über `nichtBerechtigt(grund, meldung)`: Der
 * Typ lässt den Code ohne Grund nicht zu, und der Konstruktor weist zur
 * Laufzeit jeden Code ohne passenden Grund ab (`TypeError`, im Dienst
 * `500 INTERN` – fail closed, nie ein 403 ohne Grund und nie ein Grund an
 * einem anderen Code).
 */
export class DienstFehler extends Error {
  readonly code: FehlerCode;
  readonly felder: Record<string, string[]> | undefined;
  /** Maschinenlesbarer Grund; genau bei `NICHT_BERECHTIGT` gesetzt. */
  readonly grund: VerweigerungGrund | undefined;

  constructor(
    code: Exclude<FehlerCode, 'NICHT_BERECHTIGT'>,
    meldung?: string,
    felder?: Record<string, string[]>,
  );
  constructor(
    code: 'NICHT_BERECHTIGT',
    meldung: string,
    felder: undefined,
    grund: VerweigerungGrund,
  );
  constructor(
    code: FehlerCode,
    meldung?: string,
    felder?: Record<string, string[]>,
    grund?: VerweigerungGrund,
  ) {
    super(meldung ?? code);
    const mitGrund = grund !== undefined;
    if (
      (code === 'NICHT_BERECHTIGT') !== mitGrund ||
      (mitGrund && !(VERWEIGERUNG_GRUENDE as readonly unknown[]).includes(grund))
    ) {
      throw new TypeError('DienstFehler: Verweigerungsgrund genau bei NICHT_BERECHTIGT');
    }
    this.name = 'DienstFehler';
    this.code = code;
    this.felder = felder;
    this.grund = grund;
  }

  get status(): number {
    return FEHLER_STATUS[this.code];
  }
}

/**
 * Fehlendes Recht auf einem für den Akteur sichtbaren Objekt (`403`), mit
 * maschinenlesbarem Grund und Meldung für Nutzer. Erst aufrufen, nachdem die
 * Sichtbarkeit geprüft ist (sonst `NICHT_GEFUNDEN`).
 */
export function nichtBerechtigt(grund: VerweigerungGrund, meldung: string): DienstFehler {
  return new DienstFehler('NICHT_BERECHTIGT', meldung, undefined, grund);
}
