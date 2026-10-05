// =============================================================================
// Session-Fabrik (S-05): die einzige Implementierung zum Lesen, Ausstellen und
// Löschen der Session-Cookies einer Oberfläche.
//
// Je Oberfläche gibt es genau eine Instanz: `staffSessionFactory`
// (staff-session.ts) und `portalSessionFactory` (portal-session.ts). Auth.js
// erhält Laufzeit, Cookie-Name/-Optionen und den JWT-Codec aus derselben
// Instanz (`authJs`). Die Server-Gates staffAuth()/portalAuth(), die direkten
// Ausstellungen (Portal-Magic-Link und -Profilwechsel, lokaler
// Staff-Passwort-Formularpfad), die Logout-Routen und das geschützte
// Staff-Layout verwenden ausschließlich ihre Methoden. proxy.ts bleibt
// dependency-frei und nutzt dieselbe Namensregel aus session-cookie.ts.
//
// Laufzeit und Erneuerung: Ein Session-JWT gilt 24 h ab seiner Ausstellung.
// Seitenaufrufe erneuern nichts — staffAuth()/portalAuth() und der Proxy lesen
// das Cookie nur. Ein neues JWT mit wieder vollen 24 h entsteht ausschließlich
//  - bei der Anmeldung (Staff über Auth.js, Portal über writePortalSession),
//  - beim Portal-Profilwechsel (sessionIssuedAt bleibt der ursprüngliche
//    Anmeldezeitpunkt, die 24 h zählen ab dem Wechsel) und
//  - bei jedem Aufruf des Auth.js-Endpunkts /api/auth/<surface>/session:
//    nach denselben Widerrufs- und Kontoprüfungen stellt Auth.js das Cookie
//    dort gleitend und ohne Obergrenze neu aus. Die Oberfläche ruft den
//    Endpunkt nicht auf.
// Auth.js wertet `session.updateAge` nur für Datenbank-Sessions aus; die
// frühere Angabe „4 h“ war für diese JWT-Sessions wirkungslos und entfällt.
// =============================================================================

import { cookies } from 'next/headers';
import type { JWT } from 'next-auth/jwt';
import {
  acceptedSessionCookieNames,
  isSessionCookieName,
  readSessionCookieValue,
  sessionCookieNameVariants,
} from './session-cookie';
import { createStableSessionJwtOptions } from './session-jwt';

/** W-1: explizite Session-Laufzeit beider Oberflächen (Auth.js-Default wären 30 Tage). */
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

// Wie Auth.js (SessionStore): 4096 Byte je Cookie abzüglich der Attribute.
// Größere JWTs werden als `<name>.0`, `<name>.1`, ... geschrieben.
const SESSION_COOKIE_CHUNK_SIZE = 4096 - 160;

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  domain?: string;
}

type CookieWriteOptions = SessionCookieOptions & { maxAge: number; expires?: Date };

export interface SessionCookieReader {
  get(name: string): { value: string } | undefined;
  getAll(): Array<{ name: string; value: string }>;
}

export interface SessionCookieWriter {
  set(name: string, value: string, options: CookieWriteOptions): unknown;
}

export interface SessionFactorySpec {
  /** Konfigurierter Cookie-Name (Production: `__Host-`/`__Secure-`-Präfix). */
  cookieName: string;
  /** Basisname aller Präfix-Varianten (für Dev-Lesen, Logout und Chunks). */
  cookieBase: string;
  /** Secure-Cookies (Production): dann wird nur `cookieName` akzeptiert. */
  secure: boolean;
  /** Optionale Cookie-Domain (Subdomain-Trennung). */
  domain: string | undefined;
  /** Salt neuer JWTs und alle zum Lesen zugelassenen (historischen) Salts. */
  jwtSalt: string;
  jwtDecodeSalts: readonly string[];
  secret: string;
}

/** Ziel einer direkten Ausstellung im Route-Handler (sonst: `cookies()`). */
export interface SessionIssueTarget {
  request: { cookies: SessionCookieReader };
  response: { cookies: SessionCookieWriter };
}

export interface SessionFactory {
  readonly cookieName: string;
  /** Auth.js-Konfiguration aus derselben Quelle: Strategie, Laufzeit, Codec, Cookie. */
  readonly authJs: {
    readonly session: { strategy: 'jwt'; maxAge: number };
    readonly jwt: ReturnType<typeof createStableSessionJwtOptions>;
    readonly cookies: {
      sessionToken: { name: string; options: SessionCookieOptions };
    };
  };
  /** Hat das JWT seine Laufzeit noch nicht überschritten? */
  isLive(token: JWT): boolean;
  /** Entschlüsseltes, noch laufendes JWT aus dem Request-Cookie oder null. */
  read(jar?: SessionCookieReader): Promise<JWT | null>;
  /** Stellt ein neues JWT (24 h) aus und schreibt es als Session-Cookie. */
  issue(token: JWT, target?: SessionIssueTarget): Promise<void>;
  /** Löscht alle Namensvarianten samt Chunks (Logout, Selbstheilung). */
  expire(
    request: { cookies: SessionCookieReader },
    response: { cookies: SessionCookieWriter },
  ): void;
  /** Liegt irgendeine Namensvariante oder ein Chunk vor (auch ungültig)? */
  hasCookie(jar: Pick<SessionCookieReader, 'getAll'>): boolean;
}

function isChunkOrSelf(name: string, cookieName: string): boolean {
  return (
    name === cookieName ||
    (name.startsWith(`${cookieName}.`) && /^\d+$/.test(name.slice(cookieName.length + 1)))
  );
}

function sessionCookieChunks(name: string, value: string): Array<{ name: string; value: string }> {
  if (value.length <= SESSION_COOKIE_CHUNK_SIZE) return [{ name, value }];
  const chunks: Array<{ name: string; value: string }> = [];
  for (let offset = 0; offset < value.length; offset += SESSION_COOKIE_CHUNK_SIZE) {
    chunks.push({
      name: `${name}.${chunks.length}`,
      value: value.slice(offset, offset + SESSION_COOKIE_CHUNK_SIZE),
    });
  }
  return chunks;
}

export function createSessionFactory(spec: SessionFactorySpec): SessionFactory {
  const acceptedNames = acceptedSessionCookieNames(spec.cookieName, spec.cookieBase, spec.secure);
  const codec = createStableSessionJwtOptions(spec.jwtSalt, [...spec.jwtDecodeSalts]);

  function cookieOptions(name: string): SessionCookieOptions {
    return {
      httpOnly: true,
      secure: spec.secure,
      sameSite: 'lax',
      path: '/',
      // __Host-Cookies dürfen laut Browser-Regeln kein Domain-Attribut tragen.
      ...(spec.domain && !name.startsWith('__Host-') ? { domain: spec.domain } : {}),
    };
  }

  function isLive(token: JWT): boolean {
    return typeof token.exp === 'number' && token.exp > Math.floor(Date.now() / 1000);
  }

  return {
    cookieName: spec.cookieName,
    authJs: {
      session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
      jwt: codec,
      cookies: { sessionToken: { name: spec.cookieName, options: cookieOptions(spec.cookieName) } },
    },

    isLive,

    async read(jar) {
      const raw = readSessionCookieValue(jar ?? (await cookies()), acceptedNames);
      if (!raw) return null;
      // Aktueller (stabiler) Salt zuerst; historische Salts nur als Fallback.
      const token = await codec.decode({ token: raw, secret: spec.secret, salt: spec.jwtSalt });
      return token && isLive(token) ? token : null;
    },

    async issue(token, target) {
      const value = await codec.encode({
        token,
        secret: spec.secret,
        salt: spec.jwtSalt,
        maxAge: SESSION_MAX_AGE_SECONDS,
      });
      const jar = target ? null : await cookies();
      const writer: SessionCookieWriter = target?.response.cookies ?? jar!;
      const existing = (target?.request.cookies ?? jar!).getAll().map((cookie) => cookie.name);
      const chunks = sessionCookieChunks(spec.cookieName, value);
      const written = new Set(chunks.map((chunk) => chunk.name));
      const options = cookieOptions(spec.cookieName);
      for (const chunk of chunks) {
        writer.set(chunk.name, chunk.value, { ...options, maxAge: SESSION_MAX_AGE_SECONDS });
      }
      // Wechsel zwischen ungeteiltem und geteiltem Cookie: Reste entfernen, sonst
      // läse readSessionCookieValue weiter das alte direkte Cookie.
      for (const name of existing) {
        if (!written.has(name) && isChunkOrSelf(name, spec.cookieName)) {
          writer.set(name, '', { ...options, maxAge: 0 });
        }
      }
    },

    expire(request, response) {
      const names = new Set(sessionCookieNameVariants(spec.cookieBase));
      // Auth.js teilt große JWTs in Chunks; nur den Basisnamen zu löschen ließe
      // diese als Session im Browser zurück.
      for (const cookie of request.cookies.getAll()) {
        if (isSessionCookieName(cookie.name, spec.cookieBase)) names.add(cookie.name);
      }
      for (const name of names) {
        const prefixedSecureCookie = name.startsWith('__Host-') || name.startsWith('__Secure-');
        response.cookies.set(name, '', {
          ...cookieOptions(name),
          secure: spec.secure || prefixedSecureCookie,
          expires: new Date(0),
          maxAge: 0,
        });
      }
    },

    hasCookie(jar) {
      return jar.getAll().some((cookie) => isSessionCookieName(cookie.name, spec.cookieBase));
    },
  };
}
