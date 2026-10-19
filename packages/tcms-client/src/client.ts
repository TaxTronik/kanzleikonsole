// =============================================================================
// TcmsClient — signierter Transport zum Tax-CMS (TCMS Stufe 2, ADR 0001 §3/§7).
//
// Reiner Transport: keine Geschäftslogik, kein DB-Zugriff, keine Logs. Je
// Aufruf:
//   1. Target (Pfad + Query) genau einmal bauen (ziel.ts), Body genau einmal
//      serialisieren; über genau diese Bytes `bodySha256`.
//   2. Akteursbestätigung mit `signiereAkteur` (frisches jti, iat jetzt,
//      Lebensdauer ≤ 60 s, req = Methode, Target, Body-Hash).
//   3. fetch mit `redirect: 'error'`, Zeitlimit, Dienst-Token; geprüft wird,
//      dass `pathname + search` der gesendeten URL dem signierten Target
//      entspricht.
//   4. Antwort mit Größenlimit, nur JSON, Umschlag + zod-Schema (antwort.ts).
// Wiederholt wird nur GET bei Transportfehler oder 503, mit neuer Bestätigung
// je Versuch (der Dienst weist ein wiederverwendetes jti ab); POST/PUT/PATCH/
// DELETE nie. Ein Circuit-Breaker (@taxtronik/http-utils) zählt nur Ausfälle.
//
// Verbindungsverhalten bei 401: Der Dienst antwortet bei jedem
// Authentifizierungsfehler mit `Connection: close`, bei ungültigem Token auch,
// bevor er den Body gelesen hat. undici schließt den Socket daraufhin; wird
// der Body dabei abgeschnitten, kommt statt der 401 ein Transportfehler an.
// Beides wird nie wiederholt (401 nicht, POST nicht), und jeder Antwortkörper
// wird gelesen oder verworfen, damit keine Verbindung hängen bleibt.
//
// Der private Schlüssel liegt nur als KeyObject vor (aus getTcmsConfig) und
// wird nie serialisiert, geloggt oder in Fehler übernommen; ebenso das Token.
//
// Akteursarten (TCMS Stufe 4): Ein Client bestätigt nur die Arten, mit denen er
// gebaut wurde – Standard sind Personen (`KANZLEI`, `MANDANT`). Den
// Systemakteur bestätigt nur ein Client mit ausdrücklich `['SYSTEM']`, und der
// dann keine Person. Das baut allein der Zustell-Worker
// (apps/worker/src/tcms/dienst.ts); der Client der Web-App kann einen
// Systemakteur damit auch nicht aus Versehen signieren (ADR 0001 §3.4).
// =============================================================================

import { randomBytes, KeyObject } from 'node:crypto';
import type { TcmsConfig } from '@taxtronik/config/env-schema';
import {
  CircuitBreaker,
  CircuitOpenError,
  executeResilient,
  type RetryOptions,
} from '@taxtronik/http-utils/resilience';
import {
  AKTEUR_ARTEN,
  AKTEUR_AUDIENCE,
  AKTEUR_HEADER,
  AKTEUR_ISSUER,
  AkteurClaimsSchema,
  AkteurHeaderSchema,
  AnfrageBindungSchema,
  MAX_BODY_BYTES,
  bodySha256,
  signiereAkteur,
  type AkteurArt,
  type AkteurClaims,
} from '@taxtronik/tcms-contract';
import { z } from 'zod';
import { verarbeiteAntwort, type TcmsErgebnis } from './antwort';
import { TcmsFehler, TcmsNichtVerfuegbar, TcmsProtokollFehler, TcmsUngueltig } from './fehler';
import { baueZiel, type TcmsQuery } from './ziel';

export type TcmsMethode = AkteurClaims['req']['m'];

/** Angaben zur handelnden Person; iss/aud/iat/exp/jti/req ergänzt der Client. */
export type TcmsAkteurAngaben = Omit<AkteurClaims, 'iss' | 'aud' | 'iat' | 'exp' | 'jti' | 'req'>;

/**
 * Eintrag eines künftigen Endpunktregisters im Vertrag. Ein Register kann
 * `aufruf` direkt speisen: `client.aufruf({ ...endpunkt, params, query, body, akteur })`.
 */
export interface TcmsEndpunkt<S extends z.ZodType = z.ZodType> {
  methode: TcmsMethode;
  /** Muster der Routentabelle, z. B. `/v1/mandanten/:mandantId/kontext`. */
  pfad: string;
  querySchema?: z.ZodType;
  bodySchema?: z.ZodType;
  antwortSchema: S;
}

export interface TcmsAufruf<S extends z.ZodType> extends TcmsEndpunkt<S> {
  params?: Readonly<Record<string, string>>;
  query?: TcmsQuery;
  /** JSON-Body; `undefined` = leerer Body. */
  body?: unknown;
  akteur: TcmsAkteurAngaben;
  zeitlimitMs?: number;
  maxAntwortBytes?: number;
}

export const TcmsHealthSchema = z
  .object({ version: z.string().min(1).max(100), datenbank: z.enum(['ok', 'fehler']) })
  .strict();
export type TcmsHealth = z.infer<typeof TcmsHealthSchema>;

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface TcmsClientOptionen {
  config: Pick<TcmsConfig, 'url' | 'serviceToken' | 'actorKeyId' | 'actorPrivateKey'>;
  /** Test-/DI-Override; Standard: globales fetch. */
  fetchImpl?: FetchImpl;
  /** Zeitquelle für iat/exp (Tests). */
  uhr?: () => Date;
  breaker?: CircuitBreaker;
  /** Wiederholung nur für GET bei Transportfehler/503. */
  wiederholung?: RetryOptions;
  /** Standard-Zeitlimit je Versuch. */
  zeitlimitMs?: number;
  /** Lebensdauer einer Bestätigung in Sekunden (1–60). */
  lebensdauerS?: number;
  /**
   * Akteursarten, die dieser Client bestätigt (TCMS Stufe 4). Standard:
   * `PERSONEN_AKTEURE`. `['SYSTEM']` steht nur allein – ein Client bestätigt
   * entweder Personen oder den Systemakteur, nie beides.
   */
  akteurArten?: readonly AkteurArt[];
}

/** Standard: Kanzleipersonen und Mandantenkontakte, kein Systemakteur. */
export const PERSONEN_AKTEURE: readonly AkteurArt[] = Object.freeze(['KANZLEI', 'MANDANT']);
/** Nur der Systemakteur (Zustell-Worker der kanzleikonsole). */
export const NUR_SYSTEMAKTEUR: readonly AkteurArt[] = Object.freeze(['SYSTEM']);

export const STANDARD_MAX_ANTWORT_BYTES = 8 * 1024 * 1024;
const OBERGRENZE_ANTWORT_BYTES = 64 * 1024 * 1024;
const STANDARD_ZEITLIMIT_MS = 10_000;
const HEALTH_ZEITLIMIT_MS = 3_000;
const MAX_ZEITLIMIT_MS = 120_000;
const STANDARD_LEBENSDAUER_S = 30;
const MAX_LEBENSDAUER_S = 60;
const STANDARD_WIEDERHOLUNG: RetryOptions = { retries: 2, baseDelayMs: 200 };
const BREAKER_STANDARD = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  openMessage: 'TCMS-Circuit ist offen — Dienst gilt als nicht erreichbar.',
};
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

function ganzzahlIn(wert: number, min: number, max: number): boolean {
  return Number.isSafeInteger(wert) && wert >= min && wert <= max;
}

function lokal(feld: string, grund: string): TcmsUngueltig {
  return new TcmsUngueltig({ [feld]: [grund] }, { lokal: true });
}

/** Akteursarten eines Clients prüfen (fail closed beim Bau, wie `pruefeAkteure` im Vertrag). */
function akteurArtenAus(wert: readonly AkteurArt[] | undefined): readonly AkteurArt[] {
  const arten: readonly unknown[] = wert ?? PERSONEN_AKTEURE;
  if (!Array.isArray(arten) || arten.length === 0) {
    throw new Error('TcmsClient: mindestens eine Akteursart');
  }
  for (const art of arten) {
    if (!(AKTEUR_ARTEN as readonly unknown[]).includes(art)) {
      throw new Error('TcmsClient: unbekannte Akteursart');
    }
  }
  if (new Set(arten).size !== arten.length) throw new Error('TcmsClient: Akteursart doppelt');
  if (arten.includes('SYSTEM') && arten.length !== 1) {
    throw new Error('TcmsClient: SYSTEM nur allein');
  }
  return Object.freeze([...(arten as AkteurArt[])]);
}

/** Felder einer zod-Prüfung der eigenen Eingabe (Meldungen von zod, keine Werte). */
function felderAus(praefix: string, error: z.ZodError): Record<string, string[]> {
  const felder: Record<string, string[]> = {};
  for (const issue of error.issues.slice(0, 20)) {
    const pfad = [praefix, ...issue.path.map(String)].join('.');
    (felder[pfad] ??= []).push(issue.message.slice(0, 300));
  }
  return felder;
}

function systemCode(error: unknown): string | null {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && SYSTEM_CODE.test(code) ? code : null;
}

function istRedirect(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause;
  return cause?.message === 'unexpected redirect';
}

/** Nur GET, nur Transportfehler oder 503 (ADR 0001: Wiederholung ohne Seiteneffekt). */
function wiederholbar(methode: TcmsMethode) {
  return (error: unknown): boolean =>
    methode === 'GET' &&
    error instanceof TcmsNichtVerfuegbar &&
    (error.grund === 'TRANSPORT' || (error.grund === 'STATUS' && error.status === 503));
}

/** Als Ausfall zählen Transport, Zeitlimit, 5xx und Vertragsbrüche; fachliche Antworten nicht. */
function istAusfall(error: unknown): boolean {
  return error instanceof TcmsNichtVerfuegbar || error instanceof TcmsProtokollFehler;
}

interface Senden<S extends z.ZodType> {
  methode: TcmsMethode;
  target: string;
  koerper: Uint8Array<ArrayBuffer> | null;
  bestaetigung: string | null;
  schema: S;
  zeitlimitMs: number;
  maxBytes: number;
}

export class TcmsClient {
  readonly #origin: string;
  readonly #token: string;
  readonly #kid: string;
  readonly #schluessel: KeyObject;
  readonly #fetch: FetchImpl;
  readonly #uhr: () => Date;
  readonly #breaker: CircuitBreaker;
  readonly #wiederholung: RetryOptions;
  readonly #zeitlimitMs: number;
  readonly #lebensdauerS: number;
  readonly #akteurArten: readonly AkteurArt[];

  constructor(opts: TcmsClientOptionen) {
    const { config } = opts;
    let basis: URL;
    try {
      basis = new URL(config.url);
    } catch {
      throw new Error('TcmsClient: url ist keine URL');
    }
    if (basis.protocol !== 'http:' && basis.protocol !== 'https:') {
      throw new Error('TcmsClient: url muss http(s) verwenden');
    }
    if (basis.origin !== config.url.replace(/\/$/, '')) {
      throw new Error('TcmsClient: url darf nur Schema, Host und Port enthalten');
    }
    if (typeof config.serviceToken !== 'string' || config.serviceToken.length === 0) {
      throw new Error('TcmsClient: Dienst-Token fehlt');
    }
    if (!AkteurHeaderSchema.shape.kid.safeParse(config.actorKeyId).success) {
      throw new Error('TcmsClient: kid ungültig');
    }
    const schluessel = config.actorPrivateKey;
    if (
      !(schluessel instanceof KeyObject) ||
      schluessel.type !== 'private' ||
      schluessel.asymmetricKeyType !== 'ed25519'
    ) {
      throw new Error('TcmsClient: Schlüssel ist kein privater Ed25519-Schlüssel');
    }
    const lebensdauerS = opts.lebensdauerS ?? STANDARD_LEBENSDAUER_S;
    if (!ganzzahlIn(lebensdauerS, 1, MAX_LEBENSDAUER_S)) {
      throw new Error(`TcmsClient: Lebensdauer muss 1–${MAX_LEBENSDAUER_S} s betragen`);
    }
    const zeitlimitMs = opts.zeitlimitMs ?? STANDARD_ZEITLIMIT_MS;
    if (!ganzzahlIn(zeitlimitMs, 1, MAX_ZEITLIMIT_MS)) {
      throw new Error('TcmsClient: Zeitlimit ungültig');
    }
    this.#origin = basis.origin;
    this.#token = config.serviceToken;
    this.#kid = config.actorKeyId;
    this.#schluessel = schluessel;
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#uhr = opts.uhr ?? (() => new Date());
    this.#breaker = opts.breaker ?? new CircuitBreaker(BREAKER_STANDARD);
    this.#wiederholung = opts.wiederholung ?? STANDARD_WIEDERHOLUNG;
    this.#zeitlimitMs = zeitlimitMs;
    this.#lebensdauerS = lebensdauerS;
    this.#akteurArten = akteurArtenAus(opts.akteurArten);
  }

  /** Kein Schlüssel- oder Tokenmaterial in Logs, falls jemand den Client ausgibt. */
  toJSON(): { origin: string; kid: string } {
    return { origin: this.#origin, kid: this.#kid };
  }

  /**
   * Generischer, typisierter Aufruf eines Endpunkts mit Akteursbestätigung.
   * Wirft ausschließlich `TcmsFehler`-Unterklassen.
   */
  async aufruf<S extends z.ZodType>(a: TcmsAufruf<S>): Promise<TcmsErgebnis<z.output<S>>> {
    const methode = a.methode;
    if (!AnfrageBindungSchema.shape.m.safeParse(methode).success) {
      throw lokal('methode', 'unbekannt');
    }
    const ziel = baueZiel(a.pfad, a.params, a.query);
    // Mandantenbindung des Dienstes (ADR §3.3) schon hier: ohne passendes
    // `cli` antwortete er 404; die Anfrage wird gar nicht erst gesendet.
    if (ziel.mandantId !== null && a.akteur.cli?.id !== ziel.mandantId) {
      throw lokal('akteur.cli', 'passt nicht zum Mandantenpfad');
    }
    this.#pruefeEingabe('query', a.querySchema, a.query ?? {});
    this.#pruefeEingabe('body', a.bodySchema, a.body);
    const koerper = this.#serialisiere(methode, a.body);
    const hash = bodySha256(koerper ?? new Uint8Array(0));
    // Angaben einmal vorab prüfen: ein Fehler hier ist lokal, nicht des Dienstes.
    this.#claims(a.akteur, methode, ziel.target, hash);

    const senden: Senden<S> = {
      methode,
      target: ziel.target,
      koerper,
      bestaetigung: null,
      schema: a.antwortSchema,
      zeitlimitMs: this.#zeitlimit(a.zeitlimitMs),
      maxBytes: this.#maxBytes(a.maxAntwortBytes),
    };
    try {
      return await executeResilient(
        this.#breaker,
        this.#wiederholung,
        // Nur GET bei Transportfehler/503; POST/PUT/PATCH/DELETE nie.
        wiederholbar(methode),
        // Je Versuch eine neue Bestätigung (neues jti, neues iat).
        () =>
          this.#sende({
            ...senden,
            bestaetigung: signiereAkteur(this.#claims(a.akteur, methode, ziel.target, hash), {
              kid: this.#kid,
              privateKey: this.#schluessel,
            }),
          }),
        istAusfall,
      );
    } catch (error) {
      if (error instanceof CircuitOpenError) throw new TcmsNichtVerfuegbar('BREAKER');
      throw error;
    }
  }

  /** `GET /v1/health` mit Dienst-Token, ohne Akteur, ohne Wiederholung und ohne Breaker. */
  async health(opts: { zeitlimitMs?: number } = {}): Promise<TcmsErgebnis<TcmsHealth>> {
    return this.#sende({
      methode: 'GET',
      target: '/v1/health',
      koerper: null,
      bestaetigung: null,
      schema: TcmsHealthSchema,
      zeitlimitMs: this.#zeitlimit(opts.zeitlimitMs ?? HEALTH_ZEITLIMIT_MS),
      maxBytes: 64 * 1024,
    });
  }

  #pruefeEingabe(feld: string, schema: z.ZodType | undefined, wert: unknown): void {
    if (!schema) return;
    const ergebnis = schema.safeParse(
      feld === 'query'
        ? Object.fromEntries(Object.entries(wert as TcmsQuery).filter(([, v]) => v !== undefined))
        : wert,
    );
    if (!ergebnis.success) {
      throw new TcmsUngueltig(felderAus(feld, ergebnis.error), { lokal: true });
    }
  }

  #serialisiere(methode: TcmsMethode, body: unknown): Uint8Array<ArrayBuffer> | null {
    if (body === undefined) return null;
    if (methode === 'GET') throw lokal('body', 'GET hat keinen Body');
    let json: string | undefined;
    try {
      json = JSON.stringify(body);
    } catch {
      throw lokal('body', 'nicht als JSON serialisierbar');
    }
    if (json === undefined) throw lokal('body', 'nicht als JSON serialisierbar');
    // JSON.stringify liefert wohlgeformtes Unicode (einzelne Surrogate als \u-Escape).
    const bytes = new TextEncoder().encode(json);
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw lokal('body', `größer als ${MAX_BODY_BYTES} Bytes`);
    }
    return bytes;
  }

  #claims(akteur: TcmsAkteurAngaben, m: TcmsMethode, p: string, b: string): AkteurClaims {
    // Stufe 4: nur die Arten, mit denen dieser Client gebaut wurde (vor jeder Signatur).
    if (!this.#akteurArten.includes(akteur.knd)) {
      throw lokal('akteur.knd', 'Akteursart für diesen Client nicht zugelassen');
    }
    const jetzt = Math.floor(this.#uhr().getTime() / 1000);
    const claims = {
      ...akteur,
      iss: AKTEUR_ISSUER,
      aud: AKTEUR_AUDIENCE,
      iat: jetzt,
      exp: jetzt + this.#lebensdauerS,
      jti: randomBytes(24).toString('base64url'),
      req: { m, p, b },
    };
    const geprueft = AkteurClaimsSchema.safeParse(claims);
    if (!geprueft.success) {
      // Pfade der Abweichung ohne Werte (Namen, IDs bleiben draußen).
      throw new TcmsUngueltig(
        { akteur: geprueft.error.issues.slice(0, 10).map((i) => i.path.join('.') || '_') },
        { lokal: true },
      );
    }
    return geprueft.data;
  }

  #zeitlimit(wert: number | undefined): number {
    const ms = wert ?? this.#zeitlimitMs;
    if (!ganzzahlIn(ms, 1, MAX_ZEITLIMIT_MS)) throw lokal('zeitlimitMs', 'ungültig');
    return ms;
  }

  #maxBytes(wert: number | undefined): number {
    const max = wert ?? STANDARD_MAX_ANTWORT_BYTES;
    if (!ganzzahlIn(max, 1, OBERGRENZE_ANTWORT_BYTES)) throw lokal('maxAntwortBytes', 'ungültig');
    return max;
  }

  async #sende<S extends z.ZodType>(s: Senden<S>): Promise<TcmsErgebnis<z.output<S>>> {
    const url = new URL(s.target, this.#origin);
    // Gesendetes Target = signiertes Target, byte-genau (ADR §3.2 `req.p`).
    if (url.origin !== this.#origin || `${url.pathname}${url.search}` !== s.target) {
      throw new TcmsProtokollFehler('ANFRAGE');
    }
    const headers = new Headers({
      accept: 'application/json',
      authorization: `Bearer ${this.#token}`,
    });
    if (s.bestaetigung !== null) headers.set(AKTEUR_HEADER, s.bestaetigung);
    if (s.koerper !== null) headers.set('content-type', 'application/json');

    const steuerung = new AbortController();
    let zeitlimitAbgelaufen = false;
    const timer = setTimeout(() => {
      zeitlimitAbgelaufen = true;
      steuerung.abort();
    }, s.zeitlimitMs);
    try {
      let res: Response;
      try {
        res = await this.#fetch(url.href, {
          method: s.methode,
          headers,
          body: s.koerper ?? undefined,
          redirect: 'error',
          cache: 'no-store',
          signal: steuerung.signal,
        });
      } catch (error) {
        if (zeitlimitAbgelaufen) throw new TcmsNichtVerfuegbar('ZEITLIMIT');
        if (istRedirect(error)) throw new TcmsProtokollFehler('REDIRECT');
        throw new TcmsNichtVerfuegbar('TRANSPORT', { systemCode: systemCode(error) });
      }
      try {
        return await verarbeiteAntwort(res, {
          schema: s.schema,
          maxBytes: s.maxBytes,
          signal: steuerung.signal,
          abbrechen: () => steuerung.abort(),
        });
      } catch (error) {
        if (error instanceof TcmsFehler) {
          if (zeitlimitAbgelaufen && !(error instanceof TcmsProtokollFehler)) {
            throw new TcmsNichtVerfuegbar('ZEITLIMIT', { status: res.status });
          }
          throw error;
        }
        // Lesefehler des Stroms (Verbindung abgerissen) ohne Inhalt weitergeben.
        if (zeitlimitAbgelaufen) throw new TcmsNichtVerfuegbar('ZEITLIMIT', { status: res.status });
        throw new TcmsNichtVerfuegbar('TRANSPORT', {
          status: res.status,
          systemCode: systemCode(error),
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
