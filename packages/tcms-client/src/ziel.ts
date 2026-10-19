// =============================================================================
// Request-Target einer TCMS-Anfrage (Pfad + Query), genau einmal gebaut.
//
// Der Dienst bindet die Akteursbestätigung byte-genau an das rohe Target
// (`req.p`, ADR 0001 §3.2) und nimmt nur kanonische Targets an (tcms
// apps/api/src/ziel.ts): Pfadsegmente aus `[A-Za-z0-9_~-]`, Query aus
// RFC-3986-Zeichen mit vollständiger Prozentkodierung. Der WHATWG-URL-Parser
// von fetch kodiert in der Query dagegen u. a. `'` nach (`%27`) und löst `.`/
// `..` im Pfad auf. Deshalb:
// - Pfadparameter: `encodeURIComponent`; das Ergebnis muss ein kanonisches
//   Segment sein (keine Punkte, keine Prozentkodierung), sonst wird nicht
//   gesendet – der Dienst würde ohnehin 404 antworten.
// - Query: `encodeURIComponent` plus Kodierung von `!'()*`, damit der Parser
//   nichts mehr umschreibt.
// Der Client prüft zusätzlich, dass `pathname + search` der tatsächlich
// gesendeten URL exakt dem signierten Target entspricht.
// =============================================================================

import { AnfrageBindungSchema } from '@taxtronik/tcms-contract';
import { TcmsUngueltig } from './fehler';

/** Feste Segmente wie in der Routentabelle des Dienstes. */
const SEGMENT_FEST = /^[a-z0-9-]+$/;
const SEGMENT_PARAM = /^:[a-zA-Z][a-zA-Z0-9]*$/;
/** Rohes Segment, das der Dienst als kanonisch annimmt. */
const SEGMENT_KANONISCH = /^[A-Za-z0-9_~-]+$/;
const QUERY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_ZIEL = AnfrageBindungSchema.shape.p.maxLength ?? 2048;
const MANDANT_PARAM = 'mandantId';

export type TcmsQuery = Readonly<Record<string, string | undefined>>;

export interface Ziel {
  /** Pfad inklusive Query, wie gesendet und signiert. */
  target: string;
  /** Mandant aus `/v1/mandanten/:mandantId/…`, sonst `null`. */
  mandantId: string | null;
}

function ungueltig(feld: string, grund: string): TcmsUngueltig {
  return new TcmsUngueltig({ [feld]: [grund] }, { lokal: true });
}

/** encodeURIComponent plus `!'()*`: kein Zeichen, das der URL-Parser in der Query umschreibt. */
export function kodiereQueryKomponente(wert: string): string {
  return encodeURIComponent(wert).replace(
    /[!'()*]/g,
    (zeichen) => `%${zeichen.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function kodiereSegment(name: string, wert: unknown): string {
  if (typeof wert !== 'string' || wert === '') throw ungueltig(`params.${name}`, 'fehlt');
  let kodiert: string;
  try {
    kodiert = encodeURIComponent(wert);
  } catch {
    throw ungueltig(`params.${name}`, 'kein gültiges Unicode');
  }
  if (!SEGMENT_KANONISCH.test(kodiert)) {
    throw ungueltig(`params.${name}`, 'nur A-Z a-z 0-9 _ ~ - erlaubt (kanonischer Pfad)');
  }
  return kodiert;
}

function baueQuery(query: TcmsQuery): string {
  const teile: string[] = [];
  for (const [name, wert] of Object.entries(query)) {
    if (wert === undefined) continue;
    if (!QUERY_NAME.test(name)) throw ungueltig('query', 'ungültiger Parametername');
    if (typeof wert !== 'string') throw ungueltig(`query.${name}`, 'muss ein String sein');
    try {
      teile.push(`${name}=${kodiereQueryKomponente(wert)}`);
    } catch {
      throw ungueltig(`query.${name}`, 'kein gültiges Unicode');
    }
  }
  return teile.length > 0 ? `?${teile.join('&')}` : '';
}

/**
 * Baut das Target aus einem Muster der Routentabelle (`/v1/mandanten/:mandantId/kontext`),
 * Pfadparametern und Query. Wirft `TcmsUngueltig` (lokal), wenn etwas nicht
 * kanonisch ist, ein Parameter fehlt, doppelt oder überzählig ist.
 */
export function baueZiel(
  muster: string,
  params: Readonly<Record<string, string>> = {},
  query: TcmsQuery = {},
): Ziel {
  if (typeof muster !== 'string' || !muster.startsWith('/v1/')) {
    throw ungueltig('pfad', 'muss mit /v1/ beginnen');
  }
  const benutzt = new Set<string>();
  const segmente = muster.slice(1).split('/');
  let mandantId: string | null = null;
  const kodiert = segmente.map((segment, index) => {
    if (SEGMENT_PARAM.test(segment)) {
      const name = segment.slice(1);
      if (benutzt.has(name)) throw ungueltig('pfad', 'Parameter doppelt');
      benutzt.add(name);
      const wert = Object.hasOwn(params, name) ? params[name] : undefined;
      const teil = kodiereSegment(name, wert);
      if (name === MANDANT_PARAM && index === 2 && segmente[1] === 'mandanten') {
        mandantId = wert as string;
      }
      return teil;
    }
    if (!SEGMENT_FEST.test(segment)) throw ungueltig('pfad', 'ungültiges Segment');
    return segment;
  });
  for (const name of Object.keys(params)) {
    if (!benutzt.has(name)) throw ungueltig(`params.${name}`, 'nicht im Pfad');
  }
  const target = `/${kodiert.join('/')}${baueQuery(query)}`;
  if (target.length > MAX_ZIEL) throw ungueltig('pfad', `länger als ${MAX_ZIEL} Zeichen`);
  return { target, mandantId };
}
