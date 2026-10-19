// =============================================================================
// Antwort des TCMS lesen und prüfen (TCMS Stufe 2).
//
// - 3xx: Fehler (fetch läuft mit `redirect: 'error'`; ein Mock ohne Redirect-
//   Logik landet hier).
// - 502/503/504: Dienst nicht verfügbar, Körper wird verworfen.
// - Nur `application/json` (optional `; charset=utf-8`), sonst Abbruch.
// - Größe hart begrenzt: `Content-Length` vorab, danach gestreamt; beim
//   Überschreiten wird der Strom abgebrochen, der Rest nie gelesen.
// - Strenges JSON des Vertrags (UTF-8 fatal, keine doppelten Schlüssel, kein
//   `__proto__`), dann Umschlag und Daten mit zod. Unbekannte Felder behandeln
//   die Schemas des Vertrags (dort `.strict()`: Abweichung = Protokollfehler).
// - Fehlerumschlag über FehlerSchema; Status und Code müssen zusammenpassen.
// Kein Rohkörper verlässt dieses Modul, auch nicht in Fehlermeldungen.
// =============================================================================

import {
  FEHLER_STATUS,
  FehlerSchema,
  parseJsonStrikt,
  type Fehler,
} from '@taxtronik/tcms-contract';
import { z } from 'zod';
import {
  TcmsKonflikt,
  TcmsNichtAuthentifiziert,
  TcmsNichtBerechtigt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
  TcmsProtokollFehler,
  TcmsUngueltig,
  type TcmsFehler,
  type TcmsFehlerDetails,
} from './fehler';

const JSON_TYP = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const REQUEST_ID = /^[A-Za-z0-9-]{1,64}$/;
const DEZIMAL = /^(?:0|[1-9][0-9]{0,15})$/;
const PFAD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_PFADE = 10;

const ErfolgUmschlag = z.object({ ok: z.literal(true), daten: z.unknown() }).strict();
const FehlerUmschlag = z.object({ ok: z.literal(false), fehler: FehlerSchema }).strict();

export interface TcmsErgebnis<T> {
  daten: T;
  status: number;
  /** `x-request-id` der Antwort (vom Dienst erzeugt). */
  requestId: string | null;
}

export function leseRequestId(headers: Headers): string | null {
  const wert = headers.get('x-request-id');
  return wert !== null && REQUEST_ID.test(wert) ? wert : null;
}

async function verwerfe(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * Liest den Körper mit hartem Limit. `abbrechen` beendet die Anfrage (Socket),
 * `signal` meldet ein abgelaufenes Zeitlimit auch während des Lesens.
 */
async function leseKoerper(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
  abbrechen: () => void,
  details: TcmsFehlerDetails,
): Promise<Uint8Array> {
  const angegeben = res.headers.get('content-length');
  if (angegeben !== null && (!DEZIMAL.test(angegeben) || Number(angegeben) > maxBytes)) {
    abbrechen();
    await verwerfe(res);
    throw new TcmsProtokollFehler(
      DEZIMAL.test(angegeben) ? 'ANTWORT_ZU_GROSS' : 'UMSCHLAG',
      details,
    );
  }
  if (res.body === null) return new Uint8Array(0);
  const leser = res.body.getReader();
  const beiAbbruch = () => {
    leser.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', beiAbbruch, { once: true });
  const teile: Uint8Array[] = [];
  let gelesen = 0;
  try {
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      gelesen += value.byteLength;
      if (gelesen > maxBytes) {
        abbrechen();
        await leser.cancel().catch(() => undefined);
        throw new TcmsProtokollFehler('ANTWORT_ZU_GROSS', details);
      }
      teile.push(value);
    }
  } finally {
    signal.removeEventListener('abort', beiAbbruch);
  }
  if (signal.aborted) throw new TcmsNichtVerfuegbar('ZEITLIMIT', details);
  const koerper = new Uint8Array(gelesen);
  let pos = 0;
  for (const teil of teile) {
    koerper.set(teil, pos);
    pos += teil.byteLength;
  }
  return koerper;
}

/** Abweichungspfade ohne Inhalte: nur Bezeichner und Indizes, sonst `*`. */
function pfadeAus(error: z.ZodError): string[] {
  return error.issues
    .slice(0, MAX_PFADE)
    .map((issue) =>
      ['daten', ...issue.path]
        .map((teil) =>
          typeof teil === 'number' || (typeof teil === 'string' && PFAD_SEGMENT.test(teil))
            ? String(teil)
            : '*',
        )
        .join('.'),
    );
}

function fehlerAusUmschlag(fehler: Fehler, details: TcmsFehlerDetails): TcmsFehler {
  const mit: TcmsFehlerDetails = { ...details, code: fehler.code, meldung: fehler.meldung ?? null };
  switch (fehler.code) {
    case 'UNGUELTIG':
      return new TcmsUngueltig(fehler.felder ?? {}, mit);
    case 'NICHT_AUTHENTIFIZIERT':
      return new TcmsNichtAuthentifiziert(mit);
    case 'NICHT_BERECHTIGT':
      // Der Vertrag erzwingt `grund` genau hier (FehlerSchema); ohne Grund kein 403.
      return new TcmsNichtBerechtigt({ ...mit, verweigerung: fehler.grund ?? null });
    case 'NICHT_GEFUNDEN':
      return new TcmsNichtGefunden(mit);
    case 'KONFLIKT':
      return new TcmsKonflikt(mit);
    case 'INTERN':
      return new TcmsNichtVerfuegbar('INTERN', mit);
    default:
      // METHODE_NICHT_ERLAUBT, ZU_GROSS: Fehler des Clients, nicht der Fachlogik.
      return new TcmsProtokollFehler('STATUS', mit);
  }
}

export interface AntwortOptionen<S extends z.ZodType> {
  schema: S;
  maxBytes: number;
  signal: AbortSignal;
  abbrechen: () => void;
}

/** Prüft eine Antwort vollständig und liefert die Daten oder wirft einen TcmsFehler. */
export async function verarbeiteAntwort<S extends z.ZodType>(
  res: Response,
  opts: AntwortOptionen<S>,
): Promise<TcmsErgebnis<z.output<S>>> {
  const details: TcmsFehlerDetails = { status: res.status, requestId: leseRequestId(res.headers) };
  if (res.status >= 300 && res.status < 400) {
    await verwerfe(res);
    throw new TcmsProtokollFehler('REDIRECT', details);
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    await verwerfe(res);
    throw new TcmsNichtVerfuegbar('STATUS', details);
  }
  if (!JSON_TYP.test(res.headers.get('content-type') ?? '')) {
    opts.abbrechen();
    await verwerfe(res);
    throw new TcmsProtokollFehler('CONTENT_TYPE', details);
  }
  const koerper = await leseKoerper(res, opts.maxBytes, opts.signal, opts.abbrechen, details);
  const json = parseJsonStrikt(koerper);
  if (!json.ok) throw new TcmsProtokollFehler('JSON', details);

  if (res.status === 200 || res.status === 201) {
    const umschlag = ErfolgUmschlag.safeParse(json.wert);
    if (!umschlag.success) throw new TcmsProtokollFehler('UMSCHLAG', details);
    const daten = opts.schema.safeParse(umschlag.data.daten);
    if (!daten.success) {
      throw new TcmsProtokollFehler('SCHEMA', { ...details, pfade: pfadeAus(daten.error) });
    }
    return { daten: daten.data, status: res.status, requestId: details.requestId ?? null };
  }
  const umschlag = FehlerUmschlag.safeParse(json.wert);
  if (!umschlag.success || FEHLER_STATUS[umschlag.data.fehler.code] !== res.status) {
    throw new TcmsProtokollFehler(umschlag.success ? 'STATUS' : 'UMSCHLAG', details);
  }
  throw fehlerAusUmschlag(umschlag.data.fehler, details);
}
