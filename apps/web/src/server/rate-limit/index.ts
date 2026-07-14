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

export function staffPasswordAccountRateLimitKey(staffUserId: string): string {
  return `staff-pw-account:${staffUserId}`;
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
 * Convenience-Wrapper für „per-IP-wenn-bekannt, sonst globaler Bucket".
 *
 * Hintergrund (H-2 / N-3 / K-1): `getClientIp` kann `null` zurückgeben,
 * wenn TRUST_PROXY_REQUIRED nicht gesetzt ist. Würden wir naiv
 * `prefix:${ip}` als Key bauen, landen alle null-Aufrufer in einem
 * gemeinsamen Bucket — Single-IP-Spam sperrt dann alle.
 *
 * Stattdessen: bei null nehmen wir den weiteren globalen Bucket
 * `prefix:global` mit größerer Quota — Sturm-Schutz statt Per-User-Lockout-
 * Surface.
 */
export async function checkIpOrGlobalLimit(
  prefix: string,
  ip: string | null,
  perIp: RateLimitConfig,
  global: RateLimitConfig,
): Promise<RateLimitResult> {
  if (ip) {
    return checkRateLimit(`${prefix}:${ip}`, perIp);
  }
  return checkRateLimit(`${prefix}:global`, global);
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
  } catch {
    // ignore
  }
}

/**
 * Liest die Client-IP aus üblichen Proxy-Headern (Vercel/Cloudflare/Nginx).
 *
 * H2: Trust-Boundary anhand `TRUST_PROXY_REQUIRED`. Returnt `null` (nicht
 * mehr den 'unknown'-Sentinel) wenn keine vertrauenswürdige IP zu ermitteln
 * ist — der TypeScript-Checker erinnert Aufrufer daran, den Fall zu
 * behandeln.
 *
 * Caller-Pattern:
 *   const ip = getClientIp(req.headers);
 *   if (ip) {
 *     await checkRateLimit(`login:${ip}`, ...);
 *   } else {
 *     // Globaler Sturm-Schutz, kein Per-IP-Bucket.
 *   }
 *
 * Siehe docs/compliance/tenancy-model.md / R-3 / H-2 für Hintergrund.
 */
export function getClientIp(headers: Headers): string | null {
  if (env.NODE_ENV === 'production' && !env.TRUST_PROXY_REQUIRED) {
    return null;
  }
  const xff = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = headers.get('x-real-ip');
  const cfIp = headers.get('cf-connecting-ip');
  const ip = xff || realIp || cfIp;
  if (ip) return ip;
  if (env.NODE_ENV === 'production') {
    log.warn(
      { component: 'rate-limit' },
      'getClientIp: keine Client-IP-Header gefunden — Reverse-Proxy-Config prüfen',
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
