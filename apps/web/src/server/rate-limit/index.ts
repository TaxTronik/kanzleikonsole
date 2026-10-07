// =============================================================================
// Rate-Limiter (Token-Bucket-Variante mit Redis INCR + EXPIRE)
//
// Verwendung in Server Actions / Route Handlers:
//   const r = await checkRateLimit(`login:${ip}`, { max: 5, windowSec: 600 });
//   if (!r.ok) return { error: `Zu viele Versuche. Bitte ${r.retryAfter}s warten.` };
//
// Redis ist optional — wenn nicht erreichbar, fail-open mit Logging-Warnung.
// (Production sollte Redis als hard-dependency haben; in Dev darf RL fehlen.)
// =============================================================================

// L-5: Singleton-Redis statt eigener Verbindung pro Modul.
import { createHmac, hkdfSync } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { env } from '@taxtronik/config';
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

export interface RateLimitConfig {
  max: number;
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number; // Sekunden bis Reset
}

const STAFF_PASSWORD_ACCOUNT_LIMIT: RateLimitConfig = { max: 20, windowSec: 600 };
const STAFF_SECOND_FACTOR_ACCOUNT_LIMIT: RateLimitConfig = { max: 5, windowSec: 300 };

export function staffPasswordAccountRateLimitKey(staffUserId: string): string {
  return `staff-pw-account:${staffUserId}`;
}

export function staffSecondFactorAccountRateLimitKey(staffUserId: string): string {
  return `staff-second-factor-account:${staffUserId}`;
}

/** ACCESS-TENANT-RLS-001: A password alone must not reset second-factor attempts. */
export async function checkStaffSecondFactorAccountLimit(
  staffUserId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    staffSecondFactorAccountRateLimitKey(staffUserId),
    STAFF_SECOND_FACTOR_ACCOUNT_LIMIT,
  );
}

/**
 * Pre-bcrypt Account-Bucket fuer Staff-Logins. Das IP-Limit schuetzt einzelne
 * Quellen; dieser Bucket deckelt verteilte Versuche gegen dasselbe Konto,
 * bevor bcrypt CPU kostet. Bewusst grosszuegig, damit legitime Tippfehler nicht
 * sofort zum Account-DoS werden.
 */
export async function checkStaffPasswordAccountLimit(
  staffUserId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(
    staffPasswordAccountRateLimitKey(staffUserId),
    STAFF_PASSWORD_ACCOUNT_LIMIT,
  );
}

/**
 * Globaler Spam-Backstop für Portal-Schreibpfade (S4). 60 Ops pro 10 min
 * pro Contact deckt z. B. Form-Drafts, Request-Antworten, BWA-Plan-Edits,
 * Stammdaten-Vorschläge ab — granularere Limits (Upload, Termin-Anfrage)
 * laufen weiterhin zusätzlich.
 *
 * Convenience-Wrapper, damit alle Portal-Actions denselben Key-Prefix
 * benutzen und sich Operations-Quotas konsistent debuggen lassen.
 */
export async function checkPortalWriteLimit(contactId: string): Promise<RateLimitResult> {
  return checkRateLimit(`portal-write:${contactId}`, { max: 60, windowSec: 600 });
}

/** Eigenes enges Kontingent fuer neue Mandantenpost-Verlaeufe. */
export async function checkPortalInboxThreadLimit(contactId: string): Promise<RateLimitResult> {
  return checkRateLimit(`portal-inbox-thread:${contactId}`, { max: 5, windowSec: 60 * 60 });
}

/** Uploads belasten Virenscanner und Storage zusaetzlich zum globalen Write-Limit. */
export async function checkPortalInboxUploadLimit(contactId: string): Promise<RateLimitResult> {
  return checkRateLimit(`portal-inbox-upload:${contactId}`, { max: 20, windowSec: 10 * 60 });
}

/**
 * Audit 2026-06 Befund 6: leichtes Read-Limit für Portal-Download/Preview.
 * Jeder Abruf schreibt einen Audit-Eintrag (evidenceService) — ohne Limit
 * kann ein eingeloggter Mandant Audit-Spam/DB-Last erzeugen. Großzügig
 * dimensioniert: eine Preview kostet 2 Requests (JSON-Metadata + Stream),
 * 240/10 min erlauben also ~120 Dokument-Ansichten in Folge — legitimes
 * Durchklicken der Dokumentliste bleibt unbemerkt, Spam ist auf 240
 * Audit-Einträge/10 min gedeckelt. Key pro Session-Kontakt (nicht IP):
 * trifft den Verursacher direkt, kein Fremd-Lockout hinter Shared-NAT.
 */
export async function checkPortalReadLimit(contactId: string): Promise<RateLimitResult> {
  return checkRateLimit(`portal-read:${contactId}`, { max: 240, windowSec: 600 });
}

/**
 * Per-User-Limit für die globale Staff-Suche (Defense in Depth): 30/min deckt
 * jedes legitime Typeahead, bremst aber systematisches Abgrasen (5 parallele
 * ILIKE-/FTS-Queries pro Request) über einen kompromittierten Account.
 */
export async function checkStaffSearchLimit(staffId: string): Promise<RateLimitResult> {
  return checkRateLimit(`search:${staffId}`, { max: 30, windowSec: 60 });
}

/**
 * Eigener Bucket für die Mandantenauswahl (ClientCombobox): eine einzelne,
 * gedeckelte Abfrage je Request, aber auf vielen Formularen. 120/min trägt
 * normales Tippen in mehreren Auswahlfeldern, ohne das Kontingent der
 * globalen Suche zu verbrauchen, und bremst systematisches Abgrasen.
 */
export async function checkStaffClientPickerLimit(staffId: string): Promise<RateLimitResult> {
  return checkRateLimit(`client-picker:${staffId}`, { max: 120, windowSec: 60 });
}

/**
 * Per-User-Limit für Export-Routen (CSV-Volltabellen, ZIP-Builds — teuer und
 * datenreich): 5 pro 10 min und Export-Art. Key pro Routen-Art (`kind`),
 * damit ein Mandanten-CSV nicht das Audit-Export-Kontingent verbraucht.
 */
export async function checkStaffExportLimit(
  kind: string,
  staffId: string,
): Promise<RateLimitResult> {
  return checkRateLimit(`export:${kind}:${staffId}`, { max: 5, windowSec: 600 });
}

/**
 * Backup-Downloads sind Admin-only und im Betrieb oft Doppelchecks
 * (lokale Kopie + S3-Objekt direkt nacheinander). Sie bekommen daher ein
 * eigenes, großzügigeres Limit und getrennte Buckets pro Quelle.
 */
export async function checkStaffBackupDownloadLimit(
  staffId: string,
  source: 'auto' | 'local' | 's3',
): Promise<RateLimitResult> {
  return checkRateLimit(`backup-download:${source}:${staffId}`, { max: 30, windowSec: 600 });
}

/**
 * K-3: Einheitliches Verhalten bei Redis-Ausfall.
 *  - Production: fail-CLOSED (kein Bypass über provozierte Redis-Fehler)
 *  - Dev: fail-OPEN (lokale Tests ohne Redis möglich)
 * Beide Pfade (Redis-null und Redis-Exception) gehen durch dieselbe Funktion,
 * damit eine spätere Policy-Änderung (z. B. längere Sperrzeit) nur an einer
 * Stelle nötig ist.
 */
function failedRedisResult(
  reason: 'unreachable' | 'exception',
  key: string,
  cfgMax: number,
  err?: unknown,
): RateLimitResult {
  // WICHTIG: pino-Methode NICHT als freie Variable aufrufen
  // (`const fn = log.error; fn(...)`) — dann ist `this` undefined und pino
  // wirft `Cannot read properties of undefined (reading Symbol(pino.msgPrefix))`.
  // Immer direkt als Methode auf `log` aufrufen, damit `this` gebunden bleibt.
  const payload = {
    component: 'rate-limit',
    key,
    reason,
    ...(err ? { err: (err as Error).message } : {}),
  };
  if (reason === 'unreachable') {
    // In Dev erwartet (kein Redis) → warn statt error, kein Stack-Noise.
    log.warn(payload, 'rate-limit: Redis nicht erreichbar');
  } else {
    log.error(payload, 'rate-limit: Redis-Exception');
  }
  if (env.NODE_ENV === 'production') {
    return { ok: false, remaining: 0, retryAfter: 60 };
  }
  return { ok: true, remaining: cfgMax, retryAfter: 0 };
}

// Atomares INCR + (self-healing) EXPIRE in EINEM Round-Trip. Behebt zwei
// Schwächen des früheren INCR → separates EXPIRE(nur bei count===1) → TTL:
//   - Perf: 1 statt 2–3 sequenzielle Redis-RTs (läuft vor jedem bcrypt).
//   - Robustheit: scheiterte das separate EXPIRE nach erfolgreichem INCR
//     (Crash/Hiccup), blieb der Key OHNE TTL → der Bucket lief hoch und sperrte
//     die IP DAUERHAFT (kein Reset). Das Skript setzt die TTL immer, wenn sie
//     fehlt (TTL < 0 = -1 kein Ablauf), heilt also auch verwaiste Keys.
const INCR_EXPIRE_LUA = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export async function checkRateLimit(key: string, cfg: RateLimitConfig): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) {
    return failedRedisResult('unreachable', key, cfg.max);
  }

  const fullKey = `rl:${key}`;
  try {
    const res = (await r.eval(INCR_EXPIRE_LUA, 1, fullKey, String(cfg.windowSec))) as [
      number,
      number,
    ];
    const count = Number(res[0]);
    const ttl = Number(res[1]);
    const remaining = Math.max(0, cfg.max - count);
    if (count > cfg.max) {
      return { ok: false, remaining: 0, retryAfter: Math.max(1, ttl) };
    }
    return { ok: true, remaining, retryAfter: 0 };
  } catch (e) {
    return failedRedisResult('exception', key, cfg.max, e);
  }
}

/**
 * S-03: Sturm-Obergrenze für Anfragen OHNE vertrauenswürdige Client-IP —
 * 10 Anfragen/s Dauerlast je Präfix (Fenster wie das Per-IP-Limit).
 *  - Die frühere globale Quote (100–200 je Fenster) war mit einer Anfrage alle
 *    3–9 s erschöpfbar und sperrte dann sämtliche Logins. Jetzt braucht es eine
 *    dauerhafte Flut (≥ 864.000 Anfragen/Tag); das Doppelte der Login-Rate je
 *    Quell-IP im nginx-Beispiel (limit_req 5 r/s), eine einzelne Quelle hinter
 *    diesem Proxy erschöpft sie auf den Login-Pfaden also nicht.
 *  - Legitime Spitzen einer Kanzlei-Instanz liegen um Größenordnungen darunter
 *    (z. B. 100 Portal-Logins in 15 min ≈ 0,1/s).
 *  - Die Arbeit je Anfrage bleibt meist klein: ein bis zwei indizierte
 *    Lookups bzw. eine HMAC-Prüfung; Login-Mails haben eine eigene
 *    Versandobergrenze (requestMagicLink). Ausnahme ist der Staff-
 *    Passwortschritt: Seit S-09 kostet dort jede Anfrage genau einen
 *    bcrypt-Vergleich (Dummy-Hash für unbekannte oder unzulässige Konten),
 *    damit die Antwortzeit kein Konto verrät. Ohne Client-IP bedeuten 10/s
 *    dort spürbare CPU-Last; nur existierende Konten deckelt zusätzlich ihr
 *    Passwortkontingent vor bcrypt.
 */
export const STORM_CEILING_PER_SECOND = 10;

export function stormCeiling(windowSec: number): RateLimitConfig {
  return { max: STORM_CEILING_PER_SECOND * windowSec, windowSec };
}

declare const rateLimitSubjectKeyBrand: unique symbol;

/** Pseudonymer Bucket-Schlüssel; nur über die Helfer dieses Moduls erzeugbar. */
export type RateLimitSubjectKey = string & { readonly [rateLimitSubjectKeyBrand]: true };

/** Fachlicher Bucket (E-Mail, Konto) für checkIpOrGlobalLimit. */
export interface RateLimitSubject {
  key: RateLimitSubjectKey;
  limit: RateLimitConfig;
}

let subjectKeyMaterial: { secret: string; key: Buffer } | null = null;

function subjectHmacKey(): Buffer {
  const secret = env.AUTH_SECRET;
  if (subjectKeyMaterial?.secret !== secret) {
    subjectKeyMaterial = {
      secret,
      key: Buffer.from(
        hkdfSync(
          'sha256',
          secret,
          Buffer.from('taxtronik-rate-limit-salt', 'utf8'),
          Buffer.from('taxtronik-rate-limit-subject-v1', 'utf8'),
          32,
        ),
      ),
    };
  }
  return subjectKeyMaterial.key;
}

/**
 * S-03: Bucket-Schlüssel für eine E-Mail-Adresse. HMAC-SHA-256 (Schlüssel per
 * HKDF aus AUTH_SECRET) über die getrimmte, kleingeschriebene Adresse, auf
 * 128 Bit gekürzt: Redis sieht nie die Adresse, und ohne AUTH_SECRET lässt sich
 * der Schlüssel nicht per Wörterbuch zurückrechnen. Bekannte und unbekannte
 * Adressen werden identisch behandelt (kein Enumerations-Orakel).
 */
export function emailRateLimitKey(email: string): RateLimitSubjectKey {
  return createHmac('sha256', subjectHmacKey())
    .update(`email:${email.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 32) as RateLimitSubjectKey;
}

/**
 * Limit für öffentliche Einstiege (Login, Magic-Link, Token-Links).
 *
 * S-03 (vorher H-2 / N-3 / K-1): `getClientIp` liefert in Produktion `null`,
 * solange TRUST_PROXY_REQUIRED nicht `true` ist. Früher fiel dann jedes Limit
 * auf einen kleinen gemeinsamen Bucket, den ein Angreifer mit wenigen Anfragen
 * für alle Nutzer erschöpfte. Jetzt:
 *  - Mit IP: erst `prefix:<ip>` (perIp), dann — falls übergeben — der
 *    Subjekt-Bucket `prefix:subject:<key>`, damit rotierende IPs ihn nicht
 *    umgehen. Eine einzelne Quelle verbraucht so höchstens `perIp.max` vom
 *    Subjekt-Kontingent.
 *  - Ohne IP: erst der Subjekt-Bucket (wer eine Adresse flutet, verbraucht die
 *    gemeinsame Obergrenze nicht), dann nur noch die großzügige
 *    Sturm-Obergrenze `prefix:global` (stormCeiling, Fenster wie perIp).
 *
 * Den Subjekt-Schlüssel für existierende und unbekannte Konten/Adressen gleich
 * bilden (z. B. emailRateLimitKey vor jedem Lookup). Kontogebundene Limits nach
 * dem Lookup (checkStaffPasswordAccountLimit & Co.) gelten unabhängig davon.
 */
export async function checkIpOrGlobalLimit(
  prefix: string,
  ip: string | null,
  perIp: RateLimitConfig,
  subject?: RateLimitSubject,
): Promise<RateLimitResult> {
  const checkSubject = (s: RateLimitSubject) =>
    checkRateLimit(`${prefix}:subject:${s.key}`, s.limit);
  if (ip) {
    const ipResult = await checkRateLimit(`${prefix}:${ip}`, perIp);
    return ipResult.ok && subject ? checkSubject(subject) : ipResult;
  }
  if (subject) {
    const subjectResult = await checkSubject(subject);
    if (!subjectResult.ok) return subjectResult;
  }
  return checkRateLimit(`${prefix}:global`, stormCeiling(perIp.windowSec));
}

/**
 * Bei Erfolg eines Vorgangs (z. B. erfolgreichem Login) den Counter wieder
 * zurücksetzen, damit nicht später Honest-User durch frühere Fehlversuche
 * blockiert werden.
 */
export async function resetRateLimit(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(`rl:${key}`);
  } catch (err) {
    // F-05: Ein nicht zurückgesetzter Zähler bremst den nächsten legitimen
    // Versuch; ins Log nur die Art des Schlüssels, nicht IP oder Konto.
    log.warn(
      { component: 'rate-limit', keyKind: key.split(':')[0], err: (err as Error).message },
      'rate-limit: Zurücksetzen fehlgeschlagen',
    );
  }
}

const BRACKETED_IPV6 = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_WITH_PORT = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
const IPV4_MAPPED_IPV6 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * Validiert und kanonisiert einen Adress-Eintrag aus X-Forwarded-For (S-03).
 * Erlaubt sind IPv4, IPv6, IPv6 in eckigen Klammern (optional mit Port) und
 * IPv4 mit Port. IPv6 wird kanonisch ausgegeben (klein, komprimiert), damit
 * dieselbe Adresse immer denselben Bucket trifft; IPv4-mapped IPv6
 * (`::ffff:192.0.2.1`, so meldet Node Dual-Stack-Sockets) wird zu IPv4.
 * Zonen-IDs (`fe80::1%eth0`) und alles andere ergeben `null`.
 */
export function normalizeIpAddress(raw: string): string | null {
  let value = raw.trim();
  if (!value || value.length > 64) return null;
  const bracketed = BRACKETED_IPV6.exec(value);
  if (bracketed) {
    value = bracketed[1] ?? '';
    if (!isIPv6(value)) return null;
  } else {
    value = IPV4_WITH_PORT.exec(value)?.[1] ?? value;
  }
  if (isIPv4(value)) return value;
  if (!isIPv6(value)) return null;
  let canonical: string;
  try {
    // Der WHATWG-URL-Parser serialisiert IPv6 kanonisch und lehnt Zonen-IDs ab.
    canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = IPV4_MAPPED_IPV6.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1] ?? '', 16);
  const low = Number.parseInt(mapped[2] ?? '', 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Client-Adresse aus einer X-Forwarded-For-Kette (S-03). Jeder
 * vertrauenswürdige Proxy hängt seine Gegenstelle RECHTS an (oder überschreibt
 * den Header); die Client-IP ist deshalb der `trustedHops`-te Eintrag von
 * rechts. Alles links davon kann der Client frei setzen und wird nie gelesen.
 * Enthält die Kette weniger Einträge als Hops (Request hat nicht alle Proxys
 * passiert) oder ist der Eintrag ungültig, gibt es keine Adresse.
 */
export function clientIpFromForwardedFor(
  forwardedFor: string | null,
  trustedHops: number,
): string | null {
  if (!forwardedFor || !Number.isInteger(trustedHops) || trustedHops < 1) return null;
  const entries = forwardedFor.split(',');
  if (entries.length < trustedHops) return null;
  return normalizeIpAddress(entries[entries.length - trustedHops] ?? '');
}

function trustedProxyHops(): number {
  const hops = env.TRUST_PROXY_HOPS;
  // Einige Unit-Tests mocken `env` ohne den Schlüssel; Schema-Default ist 1.
  return Number.isInteger(hops) && hops >= 1 ? hops : 1;
}

/**
 * Liest die Client-IP aus X-Forwarded-For.
 *
 * H2 / S-03: Trust-Boundary anhand `TRUST_PROXY_REQUIRED`. In Produktion ohne
 * diese Zusage → `null`; Aufrufer limitieren dann pro Konto bzw. E-Mail-Hash
 * plus Sturm-Obergrenze (checkIpOrGlobalLimit) und sperren Konten nicht hart
 * (recordFailedLogin).
 *
 * Mit Zusage zählt der TRUST_PROXY_HOPS-te Eintrag von rechts (siehe
 * clientIpFromForwardedFor) — nicht mehr der linke, den der Client setzt,
 * sobald ein Proxy anhängt statt zu überschreiben.
 *
 * Nur X-Forwarded-For wird ausgewertet. Next.js setzt den Header selbst auf die
 * TCP-Gegenstelle, wenn er fehlt (base-server: `x-forwarded-for ??=
 * socket.remoteAddress`); ein Fallback auf X-Real-IP oder CF-Connecting-IP
 * wäre in Produktion daher nie erreichbar, böte aber zusätzliche
 * Spoofing-Fläche. Hinter Cloudflare liefert TRUST_PROXY_HOPS=2 (Cloudflare
 * und eigener Proxy hängen an) dieselbe Adresse wie CF-Connecting-IP, ohne
 * einem vom Client setzbaren Header zu vertrauen.
 */
export function getClientIp(headers: Headers): string | null {
  if (env.NODE_ENV === 'production' && !env.TRUST_PROXY_REQUIRED) {
    return null;
  }
  const forwardedFor = headers.get('x-forwarded-for');
  const trustedHops = trustedProxyHops();
  const ip = clientIpFromForwardedFor(forwardedFor, trustedHops);
  if (ip) return ip;
  if (env.NODE_ENV === 'production') {
    log.warn(
      {
        component: 'rate-limit',
        trustedHops,
        forwardedEntries: forwardedFor ? forwardedFor.split(',').length : 0,
      },
      'getClientIp: keine gültige Client-IP in X-Forwarded-For — Reverse-Proxy-Config und TRUST_PROXY_HOPS prüfen',
    );
  }
  return null;
}

export class MissingClientIpError extends Error {
  constructor() {
    super('Client-IP konnte nicht ermittelt werden — Reverse-Proxy-Header fehlen.');
    this.name = 'MissingClientIpError';
  }
}

/**
 * R-3: Strikte Variante. Wenn die App ohne vertrauenswürdigen Reverse-Proxy
 * direkt am Internet läuft und keine Client-IP zu sehen ist, wirft diese
 * Funktion — der Aufrufer sollte mit HTTP 503 antworten.
 */
export function requireClientIp(headers: Headers): string {
  const ip = getClientIp(headers);
  if (ip === null && env.TRUST_PROXY_REQUIRED) {
    throw new MissingClientIpError();
  }
  return ip ?? 'unknown';
}
