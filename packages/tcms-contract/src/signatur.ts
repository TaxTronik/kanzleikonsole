// =============================================================================
// Signieren und Prüfen der Akteursbestätigung (ADR 0001, Abschnitt 3.2).
//
// Gemeinsamer Code für beide Seiten: Die kanzleikonsole signiert mit
// `signiereAkteur`, der Dienst prüft mit `pruefeAkteur`. Ausschließlich
// `node:crypto`, kompakte JWS mit Ed25519, kein allgemeiner JWT-Parser.
//
// Prüfreihenfolge (ADR §3.2): Größe → Struktur → kid → Signatur → Claims
// strikt → Zeitfenster → req. Die jti-Einmaligkeit prüft der Dienst erst nach
// erfolgreicher Prüfung (braucht Speicher). Der Payload wird erst nach der
// Signaturprüfung als JSON gelesen: Vor der Signatur verarbeitet der Dienst nur
// den kurzen Header.
//
// `PruefGrund` ist ausschließlich für das Server-Log bestimmt. Der Aufrufer
// erhält bei jedem Grund dieselbe Antwort (401 NICHT_AUTHENTIFIZIERT).
// =============================================================================

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto';
import {
  AKTEUR_MAX_BYTES,
  AKTEUR_MAX_VORLAUF_S,
  AKTEUR_TYP,
  AkteurClaimsSchema,
  AkteurHeaderSchema,
  type AkteurClaims,
} from './akteur';
import { parseJsonObjektStrikt } from './json';

/** Feste Gründe einer abgewiesenen Akteursbestätigung (nur für das Server-Log). */
export const PRUEF_GRUENDE = [
  /** fehlt, leer oder größer als 4 KiB */
  'GROESSE',
  /** nicht drei Teile, base64url ungültig oder nicht kanonisch, Header kein JSON-Objekt, doppelte Schlüssel oder `__proto__`, Signatur nicht 64 Bytes */
  'STRUKTUR',
  /** Header verletzt das Schema (alg, typ, kid, Zusatzfelder) */
  'HEADER',
  'KID_UNBEKANNT',
  /** hinterlegter Schlüssel ist kein öffentlicher Ed25519-Schlüssel */
  'SCHLUESSEL_TYP',
  'SIGNATUR',
  /** Payload kein gültiges UTF-8-JSON-Objekt, doppelte Schlüssel oder `__proto__` */
  'PAYLOAD',
  /** Claims verletzen das strikte Schema */
  'CLAIMS',
  /** übergebene Uhrzeit ungültig */
  'UHR',
  'ABGELAUFEN',
  'IAT_ZUKUNFT',
  'REQ_METHODE',
  'REQ_PFAD',
  'REQ_BODY',
] as const;

export type PruefGrund = (typeof PRUEF_GRUENDE)[number];

export type PruefErgebnis = { ok: true; claims: AkteurClaims } | { ok: false; grund: PruefGrund };

/** Die tatsächlich empfangene Anfrage, gegen die `req` geprüft wird. */
export interface AnfrageMerkmale {
  /** HTTP-Methode wie empfangen (ohne Umwandlung). */
  methode: string;
  /** Roher Pfad inklusive Query wie empfangen (ohne Normalisierung). */
  pfad: string;
  /** `bodySha256` des rohen Bodys. */
  bodySha256: string;
}

export interface PruefOptionen {
  schluessel: ReadonlyMap<string, KeyObject>;
  jetzt: Date;
  anfrage: AnfrageMerkmale;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ED25519_SIGNATUR_BYTES = 64;

/** base64url(SHA-256(bytes)), 43 Zeichen ohne Padding. */
export function bodySha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

/**
 * Signiert Claims als kompakte JWS. Wirft bei ungültigen Claims, ungültigem
 * kid, einem Schlüssel, der kein privater Ed25519-Schlüssel ist, oder einem
 * Ergebnis über 4 KiB – die kanzleikonsole soll nie ein Token erzeugen, das
 * der Dienst abweisen müsste.
 */
export function signiereAkteur(
  claims: AkteurClaims,
  schluessel: { kid: string; privateKey: KeyObject },
): string {
  if (!istEd25519(schluessel.privateKey, 'private')) {
    throw new Error('Akteursbestätigung: Schlüssel ist kein privater Ed25519-Schlüssel');
  }
  const header = AkteurHeaderSchema.parse({ alg: 'EdDSA', typ: AKTEUR_TYP, kid: schluessel.kid });
  const daten = AkteurClaimsSchema.parse(claims);
  const h = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const p = Buffer.from(JSON.stringify(daten), 'utf8').toString('base64url');
  const s = sign(null, Buffer.from(`${h}.${p}`, 'ascii'), schluessel.privateKey).toString(
    'base64url',
  );
  const token = `${h}.${p}.${s}`;
  if (token.length > AKTEUR_MAX_BYTES) {
    throw new Error('Akteursbestätigung: größer als 4 KiB');
  }
  return token;
}

/** Prüft eine Akteursbestätigung gegen Schlüssel, Uhr und Anfrage (ADR §3.2). */
export function pruefeAkteur(token: string, opts: PruefOptionen): PruefErgebnis {
  // 1. Größe – vor jeder weiteren Verarbeitung. Gültige Tokens sind reines
  //    ASCII, daher genügt die Zeichenzahl als obere Schranke der Bytes.
  if (typeof token !== 'string' || token.length === 0 || token.length > AKTEUR_MAX_BYTES) {
    return abgewiesen('GROESSE');
  }

  // 2. Struktur: drei kanonische base64url-Teile, Header als JSON-Objekt.
  const teile = token.split('.');
  if (teile.length !== 3) return abgewiesen('STRUKTUR');
  const [hText, pText, sText] = teile as [string, string, string];
  const hBytes = base64urlStrikt(hText);
  const pBytes = base64urlStrikt(pText);
  const sBytes = base64urlStrikt(sText);
  if (!hBytes || !pBytes || !sBytes || sBytes.length !== ED25519_SIGNATUR_BYTES) {
    return abgewiesen('STRUKTUR');
  }
  const headerRoh = parseJsonObjektStrikt(hBytes);
  if (!headerRoh) return abgewiesen('STRUKTUR');
  const header = AkteurHeaderSchema.safeParse(headerRoh);
  if (!header.success) return abgewiesen('HEADER');

  // 3. kid bekannt; Schlüsseltyp erneut prüfen (fail closed, auch wenn die
  //    Map nicht aus `parseSchluesselListe` stammt).
  const schluessel = opts.schluessel.get(header.data.kid);
  if (!schluessel) return abgewiesen('KID_UNBEKANNT');
  if (!istEd25519(schluessel, 'public')) return abgewiesen('SCHLUESSEL_TYP');

  // 4. Signatur über die empfangenen Zeichen `header.payload`.
  let signaturGueltig = false;
  try {
    signaturGueltig = verify(null, Buffer.from(`${hText}.${pText}`, 'ascii'), schluessel, sBytes);
  } catch {
    signaturGueltig = false;
  }
  if (!signaturGueltig) return abgewiesen('SIGNATUR');

  // 5. Claims strikt (zod, unbekannte Felder abgewiesen).
  const payloadRoh = parseJsonObjektStrikt(pBytes);
  if (!payloadRoh) return abgewiesen('PAYLOAD');
  const geparst = AkteurClaimsSchema.safeParse(payloadRoh);
  if (!geparst.success) return abgewiesen('CLAIMS');
  const claims = geparst.data;

  // 6. Zeitfenster. Eine ungültige Uhr ließe jeden Vergleich mit NaN
  //    durchfallen, daher ausdrücklich abweisen.
  const jetztMs = opts.jetzt instanceof Date ? opts.jetzt.getTime() : Number.NaN;
  if (!Number.isFinite(jetztMs)) return abgewiesen('UHR');
  if (claims.exp * 1000 <= jetztMs) return abgewiesen('ABGELAUFEN');
  if (claims.iat * 1000 > jetztMs + AKTEUR_MAX_VORLAUF_S * 1000) return abgewiesen('IAT_ZUKUNFT');

  // 7. Bindung an genau diese Anfrage, byte-genau ohne Normalisierung.
  if (claims.req.m !== opts.anfrage.methode) return abgewiesen('REQ_METHODE');
  if (claims.req.p !== opts.anfrage.pfad) return abgewiesen('REQ_PFAD');
  if (claims.req.b !== opts.anfrage.bodySha256) return abgewiesen('REQ_BODY');

  return { ok: true, claims };
}

/**
 * Liest `TCMS_ACTOR_PUBLIC_KEYS`: `kid=<base64 SPKI-DER>`, kommagetrennt.
 * Wirft bei leerer Liste, leeren Einträgen, ungültigem kid, doppeltem kid oder
 * Schlüssel, nicht kanonischem base64 und jedem Schlüssel außer Ed25519.
 * Fehlermeldungen nennen nur die Position, nie kid oder Schlüsselmaterial:
 * Steht versehentlich Schlüsselmaterial an der Stelle des kid, darf es nicht im
 * Start-Log landen.
 */
export function parseSchluesselListe(env: string): Map<string, KeyObject> {
  if (typeof env !== 'string' || env.trim() === '') {
    throw new Error('Schlüsselliste: leer');
  }
  const ergebnis = new Map<string, KeyObject>();
  const material = new Set<string>();
  env.split(',').forEach((roh, index) => {
    const nr = index + 1;
    const eintrag = roh.trim();
    if (eintrag === '') throw new Error(`Schlüsselliste: Eintrag ${nr} ist leer`);
    const trenner = eintrag.indexOf('=');
    if (trenner <= 0) throw new Error(`Schlüsselliste: Eintrag ${nr} hat nicht die Form kid=…`);
    const kid = eintrag.slice(0, trenner);
    if (!AkteurHeaderSchema.shape.kid.safeParse(kid).success) {
      throw new Error(`Schlüsselliste: Eintrag ${nr} hat einen ungültigen kid`);
    }
    if (ergebnis.has(kid)) throw new Error(`Schlüsselliste: Eintrag ${nr} hat einen doppelten kid`);
    const der = base64Strikt(eintrag.slice(trenner + 1));
    if (!der) throw new Error(`Schlüsselliste: Eintrag ${nr} ist kein kanonisches base64`);
    let schluessel: KeyObject;
    try {
      schluessel = createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch {
      throw new Error(`Schlüsselliste: Eintrag ${nr} ist kein öffentlicher Schlüssel (SPKI-DER)`);
    }
    if (!istEd25519(schluessel, 'public')) {
      throw new Error(`Schlüsselliste: Eintrag ${nr} ist kein Ed25519-Schlüssel`);
    }
    // Rundreise: genau die kanonische SPKI-Kodierung, keine angehängten Bytes.
    if (!schluessel.export({ format: 'der', type: 'spki' }).equals(der)) {
      throw new Error(`Schlüsselliste: Eintrag ${nr} ist keine kanonische SPKI-Kodierung`);
    }
    const fingerabdruck = der.toString('base64');
    if (material.has(fingerabdruck)) {
      throw new Error(
        `Schlüsselliste: Schlüssel von Eintrag ${nr} ist bereits unter anderem kid gelistet`,
      );
    }
    material.add(fingerabdruck);
    ergebnis.set(kid, schluessel);
  });
  return ergebnis;
}

/**
 * Liest den privaten Schlüssel der kanzleikonsole (PKCS8-DER, base64, wie von
 * `pnpm akteur:schluessel` ausgegeben). Wirft ohne Schlüsselmaterial in der
 * Meldung, wenn es kein privater Ed25519-Schlüssel ist.
 */
export function parsePrivatenSchluessel(base64Pkcs8: string): KeyObject {
  const der = typeof base64Pkcs8 === 'string' ? base64Strikt(base64Pkcs8.trim()) : null;
  if (!der) throw new Error('Privater Schlüssel: kein kanonisches base64');
  let schluessel: KeyObject;
  try {
    schluessel = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch {
    throw new Error('Privater Schlüssel: kein PKCS8-DER');
  }
  if (!istEd25519(schluessel, 'private')) {
    throw new Error('Privater Schlüssel: kein Ed25519-Schlüssel');
  }
  return schluessel;
}

// -----------------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------------

function abgewiesen(grund: PruefGrund): PruefErgebnis {
  return { ok: false, grund };
}

function istEd25519(schluessel: unknown, typ: 'public' | 'private'): schluessel is KeyObject {
  return (
    schluessel instanceof KeyObject &&
    schluessel.type === typ &&
    schluessel.asymmetricKeyType === 'ed25519'
  );
}

/**
 * base64url ohne Padding und ohne fremde Zeichen. `Buffer.from` ist tolerant
 * (ignoriert Fremdzeichen, akzeptiert gesetzte Restbits); deshalb muss die
 * Rundreise byte-gleich sein. Sonst gäbe es mehrere Schreibweisen derselben
 * Signatur.
 */
function base64urlStrikt(text: string): Buffer | null {
  if (text.length === 0 || text.length % 4 === 1 || !BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

/** Standard-base64 mit Padding, kanonisch (Rundreise byte-gleich). */
function base64Strikt(text: string): Buffer | null {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  return bytes.toString('base64') === text ? bytes : null;
}
