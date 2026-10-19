// =============================================================================
// Typisierte Fehler des TCMS-Clients (TCMS Stufe 2).
//
// Meldungen sind feste Texte mit Status und Fehlercode – nie Antwortkörper,
// Header-Werte, Token oder Schlüsselmaterial (§ 203 StGB; vgl.
// extractRiskLayerError). Aus der Antwort übernommen werden nur Felder, die
// der Vertrag als für Nutzer bestimmt beschreibt und mit FehlerSchema begrenzt
// (`meldung` ≤ 500 Zeichen, `felder`), und zwar als Eigenschaften, nicht in
// `message`: Loggt ein Aufrufer `error.message`, landet nichts aus dem Dienst
// im Log.
// =============================================================================

import type { FehlerCode } from '@taxtronik/tcms-contract';

export interface TcmsFehlerDetails {
  status?: number | null;
  code?: FehlerCode | null;
  requestId?: string | null;
  meldung?: string | null;
}

export abstract class TcmsFehler extends Error {
  /** HTTP-Status der Antwort, `null` ohne Antwort (lokal, Transport). */
  readonly status: number | null;
  /** Fehlercode aus dem Antwortumschlag, falls vorhanden. */
  readonly code: FehlerCode | null;
  /** `x-request-id` der Antwort (vom Dienst erzeugt) zur Korrelation mit dessen Log. */
  readonly requestId: string | null;
  /** Für Nutzer bestimmte Meldung des Dienstes (FehlerSchema), nie in `message`. */
  readonly meldung: string | null;

  protected constructor(name: string, text: string, details: TcmsFehlerDetails = {}) {
    super(text);
    this.name = name;
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.requestId = details.requestId ?? null;
    this.meldung = details.meldung ?? null;
  }
}

function mitStatus(text: string, details: TcmsFehlerDetails): string {
  if (details.status == null) return text;
  return `${text} (HTTP ${details.status}${details.code ? `, ${details.code}` : ''})`;
}

/** 404: Objekt oder Mandant gibt es für diesen Akteur nicht (auch fremder Tenant). */
export class TcmsNichtGefunden extends TcmsFehler {
  constructor(details: TcmsFehlerDetails = {}) {
    super('TcmsNichtGefunden', mitStatus('TCMS: nicht gefunden', details), details);
  }
}

/** 403: fachlich nicht berechtigt (z. B. Vier-Augen); `grund` ist die Meldung des Dienstes. */
export class TcmsNichtBerechtigt extends TcmsFehler {
  readonly grund: string | null;
  constructor(details: TcmsFehlerDetails = {}) {
    super('TcmsNichtBerechtigt', mitStatus('TCMS: nicht berechtigt', details), details);
    this.grund = details.meldung ?? null;
  }
}

/** 409: Zustand hat sich geändert oder Entscheidung liegt schon vor. */
export class TcmsKonflikt extends TcmsFehler {
  constructor(details: TcmsFehlerDetails = {}) {
    super('TcmsKonflikt', mitStatus('TCMS: Konflikt', details), details);
  }
}

/**
 * 400 des Dienstes (`lokal: false`, `felder` aus dem Umschlag) oder eine
 * Anfrage, die der Client gar nicht erst sendet (`lokal: true`), etwa ein
 * Pfadparameter mit Zeichen außerhalb des kanonischen Pfads.
 */
export class TcmsUngueltig extends TcmsFehler {
  readonly felder: Readonly<Record<string, readonly string[]>>;
  readonly lokal: boolean;
  constructor(
    felder: Readonly<Record<string, readonly string[]>>,
    details: TcmsFehlerDetails & { lokal?: boolean } = {},
  ) {
    super(
      'TcmsUngueltig',
      details.lokal
        ? 'TCMS: Anfrage ungültig (nicht gesendet)'
        : mitStatus('TCMS: Anfrage ungültig', details),
      details,
    );
    this.felder = felder;
    this.lokal = details.lokal === true;
  }
}

/**
 * 401: Dienst-Token oder Akteursbestätigung abgewiesen. Der Dienst nennt den
 * Grund absichtlich nicht (nur in seinem Log, über `requestId` auffindbar).
 */
export class TcmsNichtAuthentifiziert extends TcmsFehler {
  constructor(details: TcmsFehlerDetails = {}) {
    super(
      'TcmsNichtAuthentifiziert',
      mitStatus('TCMS: Authentifizierung abgewiesen', details),
      details,
    );
  }
}

export type TcmsAusfallGrund = 'TRANSPORT' | 'ZEITLIMIT' | 'STATUS' | 'INTERN' | 'BREAKER';

/** Dienst nicht erreichbar oder gestört (Transport, Zeitlimit, 5xx, offener Breaker). */
export class TcmsNichtVerfuegbar extends TcmsFehler {
  readonly grund: TcmsAusfallGrund;
  /** Systemcode des Transportfehlers (z. B. ECONNREFUSED), ohne Ziel und Text. */
  readonly systemCode: string | null;
  constructor(
    grund: TcmsAusfallGrund,
    details: TcmsFehlerDetails & { systemCode?: string | null } = {},
  ) {
    super('TcmsNichtVerfuegbar', mitStatus(`TCMS nicht verfügbar: ${grund}`, details), details);
    this.grund = grund;
    this.systemCode = details.systemCode ?? null;
  }
}

export type TcmsProtokollGrund =
  | 'STATUS'
  | 'REDIRECT'
  | 'CONTENT_TYPE'
  | 'ANTWORT_ZU_GROSS'
  | 'JSON'
  | 'UMSCHLAG'
  | 'SCHEMA'
  | 'ANFRAGE';

/** Alles Unerwartete: Antwort verletzt den Vertrag oder die Grenzen des Clients. */
export class TcmsProtokollFehler extends TcmsFehler {
  readonly grund: TcmsProtokollGrund;
  /**
   * Bei `SCHEMA`: Pfade der Abweichungen (höchstens 10). Nur Bezeichner und
   * Indizes; andere Schlüssel (z. B. IDs in Records) erscheinen als `*`.
   */
  readonly pfade: readonly string[];
  constructor(
    grund: TcmsProtokollGrund,
    details: TcmsFehlerDetails & { pfade?: readonly string[] } = {},
  ) {
    super('TcmsProtokollFehler', mitStatus(`TCMS-Protokollfehler: ${grund}`, details), details);
    this.grund = grund;
    this.pfade = details.pfade ?? [];
  }
}
