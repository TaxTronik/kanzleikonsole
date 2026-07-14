// =============================================================================
// ElsterBridgeClient — typisierter HTTP-Client um die eric-bridge.
//
// Reiner Transport: Bearer-Auth, Timeout pro Call, Schema-Validierung.
// KEINE Geschäftslogik (kein DB-/Request-Zugriff — Persistenz, Audit-Events
// und PIN-Eingabe passieren app-/worker-seitig).
//
// Der Default-Transport ist ein enger, trusted Backend-Fetch (Muster
// Risk-Layer): ELSTER_BRIDGE_URL kommt aus Operator-ENV, die Pfade sind fest
// codiert, die Bridge hängt im internen Compose-Netz. Kein Circuit-Breaker:
// die Bridge ist ein einzelner lokaler Container, und die authentifizierten
// Abfragen sollen NIE automatisch wiederholt werden (jeder Aufruf erzeugt
// einen Vorgang beim ELSTER-Server).
//
// Die PIN des Portalzertifikats wird pro Aufruf durchgereicht und hier weder
// gespeichert noch geloggt.
// =============================================================================

import { z } from 'zod';
import { requireElsterConfig, type ElsterConfig } from './config';
import {
  AbfrageResponseSchema,
  BridgeHealthSchema,
  KontoabfrageResponseSchema,
  KontoabfrageTeilSchema,
  ValidateResponseSchema,
  type AbfrageResponse,
  type BridgeHealth,
  type KontoabfrageResponse,
  type KontoabfrageTeil,
  type ValidateResponse,
} from './schema';

/** Ober-/Untergrenze der Teil-Abfragen pro Kontoabfrage-Vorgang (siehe kontoabfrage()). */
const KONTOABFRAGE_MIN_TEILE = 1;
const KONTOABFRAGE_MAX_TEILE = 75;

/**
 * Lokale Validierung der Kontoabfrage-Eingabe: min. 1, max. 75 Teil-Abfragen,
 * jede gegen `KontoabfrageTeilSchema`. Bewusst getrennte Instanz, damit die
 * Fehlermeldung die Kontoabfrage-Grenzen benennt.
 */
const KontoabfrageTeileSchema = z
  .array(KontoabfrageTeilSchema)
  .min(KONTOABFRAGE_MIN_TEILE)
  .max(KONTOABFRAGE_MAX_TEILE)
  // Alle Teil-Abfragen eines Vorgangs müssen dasselbe Finanzamt betreffen —
  // die ersten 4 Ziffern der 13-stelligen Steuernummer sind der Finanzamts-
  // Schlüssel (Bundeseinheitliches Format). ELSTER lehnt gemischte Vorgänge
  // ohnehin ab; hier VOR dem kostenpflichtigen Bridge-Call abfangen.
  .refine(
    (teile) => new Set(teile.map((t) => t.steuernummer.slice(0, 4))).size <= 1,
    'Alle Teil-Abfragen müssen Steuernummern desselben Finanzamts (gleiche ersten 4 Ziffern) tragen.',
  );

// Validierung ist lokal/CPU-gebunden (kein Serverkontakt) — trotzdem großzügig:
// der erste Aufruf einer Datenart lädt das Prüf-Plugin nach.
const VALIDATE_TIMEOUT_MS = 30_000;
// Authentifizierte Abfragen laufen über den ELSTER-Server (Roundtrip + Krypto).
const ABFRAGE_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Ungültige Kontoabfrage-Eingabe — lokal erkannt, BEVOR ein kostenpflichtiger
 * Vorgang beim ELSTER-Server entsteht. Eigene Klasse, damit Caller den
 * Validierungsfehler sauber vom Transport-/HTTP-Fehler trennen.
 */
export class ElsterKontoabfrageInputError extends Error {
  constructor(
    message: string,
    /** Strukturierte zod-Issues (ohne die Eingabewerte selbst). */
    readonly issues: readonly z.core.$ZodIssue[] = [],
  ) {
    super(message);
    this.name = 'ElsterKontoabfrageInputError';
  }
}

/** Nur ein Fehlercode-/Fehlertext-Feld aus einer Bridge-Fehlerantwort — KEINE Nutzdaten. */
const BridgeErrorBodySchema = z.object({
  error: z.string().optional(),
  errorText: z.string().nullable().optional(),
  returnCode: z.number().int().optional(),
});

/**
 * Extrahiert aus einem Fehler-Body nur das strukturierte Fehlerfeld (error /
 * errorText / returnCode). Gelingt das Parsen nicht oder fehlt jedes Feld, wird
 * `null` geliefert — der rohe Body landet dann NICHT in der Message.
 */
function extractBridgeError(body: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = BridgeErrorBodySchema.safeParse(json);
  if (!parsed.success) return null;
  const { error, errorText, returnCode } = parsed.data;
  const label = error ?? errorText ?? null;
  if (label && returnCode !== undefined) return `${label} (returnCode ${returnCode})`;
  if (label) return label;
  if (returnCode !== undefined) return `returnCode ${returnCode}`;
  return null;
}

/**
 * HTTP-Fehler der Bridge (non-2xx). Die Message trägt bewusst KEINEN rohen
 * Response-Body (potenziell Steuerdaten → Logs/Monitoring), sondern nur Status,
 * Pfad und — falls strukturiert parsebar — ein Fehlercode-/Fehlertext-Feld.
 * Der vollständige Body bleibt in `body` verfügbar, wird aber nicht mitgeloggt.
 */
export class ElsterBridgeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    const detail = extractBridgeError(body);
    super(
      detail
        ? `eric-bridge ${path} antwortete ${status}: ${detail}`
        : `eric-bridge ${path} antwortete ${status}.`,
    );
    this.name = 'ElsterBridgeHttpError';
  }
}

async function trustedBridgeFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Bridge-URL muss http(s) sein (war: ${parsed.protocol}).`);
  }
  return fetch(parsed.toString(), {
    ...init,
    redirect: 'error',
  });
}

/** Übertragungsmodus: Testbetrieb (Clearingstelle verwirft nach Validierung)
 *  oder EXPLIZIT erklärter Echtfall. Die Bridge lehnt Aufrufe ohne diese
 *  Entscheidung ab — versehentliche Echtübermittlungen sind so ausgeschlossen. */
export type Uebertragung = { testmerker: string } | { echtfall: true };

export interface KontoabfrageInput {
  /** Teil-Abfragen (max. 75, alle Steuernummern desselben Finanzamts). */
  abfragen: KontoabfrageTeil[];
  /** <DatenLieferant> des TransferHeaders — die Kanzlei. */
  datenLieferant: string;
  /** PIN des Portalzertifikats — pro Vorgang, wird nicht persistiert. */
  pin: string;
  uebertragung: Uebertragung;
}

export interface ElsterBridgeClientOptions {
  /** Override der Config (Tests); Default: aus @taxtronik/config. */
  config?: ElsterConfig;
  /** Override des fetch (Tests); Default: trustedBridgeFetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

export class ElsterBridgeClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(opts: ElsterBridgeClientOptions = {}) {
    const cfg = opts.config ?? requireElsterConfig();
    this.url = cfg.url.replace(/\/$/, '');
    this.token = cfg.token;
    this.fetchImpl = opts.fetchImpl ?? trustedBridgeFetch;
  }

  /** `GET /healthz` — Bridge erreichbar, ERiC geladen, Zertifikat/Hersteller-ID gesetzt? */
  async health(): Promise<BridgeHealth> {
    const raw = await this.request('GET', '/healthz', {
      timeoutMs: HEALTH_TIMEOUT_MS,
      auth: false,
    });
    return BridgeHealthSchema.parse(raw);
  }

  /**
   * `POST /v1/validate` — Stufe 1: Datensatz lokal gegen das Prüf-Plugin der
   * Datenart validieren (kein Serverkontakt, kein Zertifikat).
   */
  async validate(input: { xml: string; datenartVersion: string }): Promise<ValidateResponse> {
    const raw = await this.request('POST', '/v1/validate', {
      body: input,
      timeoutMs: VALIDATE_TIMEOUT_MS,
    });
    return ValidateResponseSchema.parse(raw);
  }

  /**
   * `POST /v1/kontoabfrage` — Stufe 2: Kontoabfrage (Istbuchungen, offene
   * Beträge, Sollstellungen) aus strukturierten Parametern. Datenteil und
   * TransferHeader (inkl. Hersteller-ID) entstehen in der Bridge.
   */
  async kontoabfrage(input: KontoabfrageInput): Promise<KontoabfrageResponse> {
    // Lokale Vorab-Validierung: jeder Bridge-Call erzeugt einen
    // kostenpflichtigen ELSTER-Vorgang — fehlerhafte Eingaben (0 oder >75
    // Teil-Abfragen, ungültige Steuernummer/Steuerart) hier abfangen.
    const validated = KontoabfrageTeileSchema.safeParse(input.abfragen);
    if (!validated.success) {
      const count = Array.isArray(input.abfragen) ? input.abfragen.length : 0;
      throw new ElsterKontoabfrageInputError(
        `Ungültige Kontoabfrage: ${count} Teil-Abfrage(n) — erlaubt sind ` +
          `${KONTOABFRAGE_MIN_TEILE}–${KONTOABFRAGE_MAX_TEILE} gültige Teil-Abfragen.`,
        validated.error.issues,
      );
    }

    const raw = await this.request('POST', '/v1/kontoabfrage', {
      body: {
        abfragen: validated.data,
        datenLieferant: input.datenLieferant,
        pin: input.pin,
        ...input.uebertragung,
      },
      timeoutMs: ABFRAGE_TIMEOUT_MS,
    });
    return KontoabfrageResponseSchema.parse(raw);
  }

  /**
   * `POST /v1/abfrage` — Stufe 2, generisch: beliebige Datenart mit
   * selbst gebautem Datenteil (OHNE Namespaces an <DatenTeil>/<Elster>,
   * OHNE TransferHeader — beides ergänzt die Bridge). Für künftige
   * Datenarten, bis sie einen eigenen Komfort-Endpunkt bekommen.
   */
  async abfrage(input: {
    datenteil: string;
    datenartVersion: string;
    verfahren: string;
    datenart: string;
    vorgang: string;
    datenLieferant: string;
    pin: string;
    uebertragung: Uebertragung;
  }): Promise<AbfrageResponse> {
    const { uebertragung, ...rest } = input;
    const raw = await this.request('POST', '/v1/abfrage', {
      body: { ...rest, ...uebertragung },
      timeoutMs: ABFRAGE_TIMEOUT_MS,
    });
    return AbfrageResponseSchema.parse(raw);
  }

  // --- intern ---------------------------------------------------------------

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; timeoutMs: number; auth?: boolean },
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.auth !== false) headers.authorization = `Bearer ${this.token}`;
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs),
    };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(`${this.url}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ElsterBridgeHttpError(res.status, path, text);
    }
    return res.json();
  }
}
