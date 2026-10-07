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
// Laufzeit: absolut 24 h ab der ursprünglichen Anmeldung (`sessionIssuedAt`,
// der signierte Anmeldeanker, den auch der Widerruf nutzt). Seitenaufrufe
// erneuern nichts — staffAuth()/portalAuth() und der Proxy lesen das Cookie
// nur. Neu ausgestellt wird ein JWT nur bei der Anmeldung und beim Portal-
// Profilwechsel (übernimmt den Anker); den Auth.js-Endpunkt
// /api/auth/<surface>/session, der früher ebenfalls erneuerte, sperrt die
// Route (B5, authjs-route.ts). Keine dieser Ausstellungen reicht über
// Anmeldung + 24 h hinaus: der Codec setzt `exp` höchstens auf diese Grenze,
// isLive() lehnt danach jedes Cookie ab, auch eines, dessen `exp` eine
// frühere gleitende Erneuerung verlängert hat.
// Tokens ohne gültigen Anker (Altbestand) werden nie verlängert, sondern
// enden spätestens zu ihrem bisherigen `exp`; die Server-Gates lehnen sie
// ohnehin ab (ACCESS-TENANT-RLS-001).
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
import { getSessionIssuedAt } from './session-issued-at';

/**
 * W-1: Session-Laufzeit beider Oberflächen (Auth.js-Default wären 30 Tage),
 * absolut gezählt ab der ursprünglichen Anmeldung.
 */
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

export class SessionLifetimeExceededError extends Error {
  constructor() {
    super('Die Session hat ihre absolute Laufzeit erreicht oder keinen Anmeldezeitpunkt.');
    this.name = 'SessionLifetimeExceededError';
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Spätester Ablauf eines Tokens: Anmeldung + 24 h. Ohne gültigen Anker gilt
 * nur der bisherige `exp` (nie verlängern); ohne beides gibt es keinen.
 */
function sessionLifetimeEnd(token: JWT): number | null {
  const loginAt = getSessionIssuedAt(token);
  if (loginAt !== undefined) return loginAt + SESSION_MAX_AGE_SECONDS;
  return typeof token.exp === 'number' ? token.exp : null;
}

/** Restlaufzeit für ein neu ausgestelltes JWT; wirft, wenn keine bleibt. */
function remainingLifetimeSeconds(token: JWT | undefined): number {
  const end = token ? sessionLifetimeEnd(token) : null;
  const remaining = end === null ? 0 : Math.min(SESSION_MAX_AGE_SECONDS, end - nowSeconds());
  if (remaining <= 0) throw new SessionLifetimeExceededError();
  return remaining;
}

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
  /** Läuft das JWT noch — eigener `exp` und Anmeldung + 24 h? */
  isLive(token: JWT): boolean;
  /** Tatsächliches Ende der Session als ISO-Zeitpunkt (für Session.expires). */
  expiresAt(token: JWT): string;
  /** Entschlüsseltes, noch laufendes JWT aus dem Request-Cookie oder null. */
  read(jar?: SessionCookieReader): Promise<JWT | null>;
  /** Stellt ein JWT bis höchstens Anmeldung + 24 h aus und setzt das Cookie. */
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
  const stableCodec = createStableSessionJwtOptions(spec.jwtSalt, [...spec.jwtDecodeSalts]);
  // Jede Ausstellung — Auth.js-Login, Auth.js-Erneuerung, direkte Ausstellung —
  // endet spätestens bei Anmeldung + 24 h, unabhängig vom übergebenen maxAge.
  const codec: ReturnType<typeof createStableSessionJwtOptions> = {
    encode: (params) =>
      stableCodec.encode({ ...params, maxAge: remainingLifetimeSeconds(params.token) }),
    decode: (params) => stableCodec.decode(params),
  };

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
    const now = nowSeconds();
    const end = sessionLifetimeEnd(token);
    return typeof token.exp === 'number' && token.exp > now && end !== null && end > now;
  }

  function expiresAt(token: JWT): string {
    const end = sessionLifetimeEnd(token);
    const exp = typeof token.exp === 'number' ? token.exp : nowSeconds();
    return new Date(Math.min(exp, end ?? exp) * 1000).toISOString();
  }

  return {
    cookieName: spec.cookieName,
    authJs: {
      session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
      jwt: codec,
      cookies: { sessionToken: { name: spec.cookieName, options: cookieOptions(spec.cookieName) } },
    },

    isLive,
    expiresAt,

    async read(jar) {
      const raw = readSessionCookieValue(jar ?? (await cookies()), acceptedNames);
      if (!raw) return null;
      // Aktueller (stabiler) Salt zuerst; historische Salts nur als Fallback.
      const token = await codec.decode({ token: raw, secret: spec.secret, salt: spec.jwtSalt });
      return token && isLive(token) ? token : null;
    },

    async issue(token, target) {
      const maxAge = remainingLifetimeSeconds(token);
      const value = await codec.encode({ token, secret: spec.secret, salt: spec.jwtSalt, maxAge });
      const jar = target ? null : await cookies();
      const writer: SessionCookieWriter = target?.response.cookies ?? jar!;
      const existing = (target?.request.cookies ?? jar!).getAll().map((cookie) => cookie.name);
      const chunks = sessionCookieChunks(spec.cookieName, value);
      const written = new Set(chunks.map((chunk) => chunk.name));
      const options = cookieOptions(spec.cookieName);
      for (const chunk of chunks) {
        writer.set(chunk.name, chunk.value, { ...options, maxAge });
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
