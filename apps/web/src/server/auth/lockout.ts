// =============================================================================
// Account-Lockout — Defense in Depth zum IP-Rate-Limit (S2 + L-4)
//
// IP-Rate-Limit allein ist gegen verteilte Brute-Force (verschiedene IPs gegen
// denselben Account) wirkungslos. Mit einem User-gebundenen Fehlversuchszähler
// + automatischer Sperre wird das Konto unabhängig von der Quell-IP geschützt.
//
// L-4: Reine Account-Sperre nach N Fehlversuchen ist ein Lockout-DoS-Vektor:
// Wer eine Mitarbeiter-E-Mail kennt, kann mit Fehlpasswörtern die Sperre
// auslösen und den Account 30 min blockieren. Wir koppeln den Account-Lockout
// jetzt an die Anzahl _unterschiedlicher_ IPs in einem rollierenden Fenster.
// Single-IP-Brute-Force fängt das IP-Rate-Limit (10/10min) auf, ohne den
// Account zu sperren. Erst wenn ≥ 5 verschiedene IPs gegen denselben Account
// fehlschlagen, wird der Account gesperrt — das deutet auf Distributed-Attack
// hin, in dem Fall ist Account-Lockout das richtige Werkzeug.
//
// Schwellwerte: 5 distinkte Quell-IPs in 30 min → 30 min Sperre.
//
// S-03: Ohne vertrauenswürdige Client-IP (Produktion ohne
// TRUST_PROXY_REQUIRED) gibt es KEINE harte Sperre mehr. Vorher fiel der Pfad
// auf reines Zählen zurück: fünf anonyme Fehlversuche sperrten jedes bekannte
// Konto 30 min, auch für den Inhaber mit korrektem Passwort und TOTP. Den
// Brute-Force-Schutz tragen dann die kontogebundenen Limits vor bcrypt bzw.
// vor der Codeprüfung (20 Passwortversuche/10 min, 5 TOTP-/Backup-Code-Versuche
// je 5 min, siehe server/rate-limit). Ein Angreifer kann damit höchstens die
// Passwortanmeldung eines bekannten Kontos drosseln, solange er das Limit
// laufend ausschöpft — aber keine 30-min-Sperre mehr auslösen.
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { log } from '@/server/logger';
import { getRedis } from '@/server/redis';

export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 30 * 60 * 1000;
const DISTINCT_IP_WINDOW_SEC = 30 * 60;

/** `null` und der Legacy-Sentinel 'unknown' bedeuten: keine vertrauenswürdige Client-IP. */
function isKnownClientIp(ip: string | null): ip is string {
  return Boolean(ip) && ip !== 'unknown';
}

async function countDistinctFailIps(userId: string, ip: string): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  const key = `staff-fail-ips:${userId}`;
  try {
    await r.sadd(key, ip);
    await r.expire(key, DISTINCT_IP_WINDOW_SEC);
    const count = await r.scard(key);
    return typeof count === 'number' ? count : null;
  } catch (err) {
    // F-05: Ohne Zählung greift nur das kontogebundene Rate-Limit; der
    // Redis-Ausfall gehört ins Log (ohne Konto-ID und IP).
    log.warn(
      { component: 'lockout', err: (err as Error).message },
      'lockout: Redis-Zählung der Fehlversuchs-IPs fehlgeschlagen',
    );
    return null;
  }
}

async function resetDistinctFailIps(userId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(`staff-fail-ips:${userId}`);
  } catch (err) {
    log.warn(
      { component: 'lockout', err: (err as Error).message },
      'lockout: Redis-DEL der Fehlversuchs-IPs fehlgeschlagen',
    );
  }
}

/**
 * Erhöht den Fehlversuchszähler. Bei Erreichen des Schwellwerts wird
 * `lockedUntil` gesetzt und der Zähler zurückgesetzt — sodass nach Ablauf
 * der Sperre wieder von 0 gezählt wird.
 *
 * L-4: `ip` wird übergeben, um den Account-Lockout an _verschiedene_ Quell-IPs
 * zu binden. Single-IP-Spam fängt das IP-Rate-Limit ab, ohne den Account zu
 * sperren — kein Lockout-DoS mehr durch bekannte E-Mail-Adresse.
 *
 * S-03: Ohne bekannte IP wird nur gezählt, nie gesperrt (siehe Kopfkommentar).
 * Der Count-Fallback bleibt allein für Redis-Ausfälle MIT bekannter IP.
 *
 * Wird mit `prismaOwner` (BYPASSRLS) aufgerufen, weil der Login-Flow
 * vor dem RLS-Context läuft.
 *
 * RF-12: gibt zurück, ob DIESER Fehlversuch das Konto gesperrt hat — die
 * Call-Sites schreiben darauf basierend auth.login.lockout in die Audit-Chain
 * (siehe login-audit.ts). Bestehende Aufrufer dürfen das Ergebnis ignorieren.
 */
export async function recordFailedLogin(
  prismaOwner: PrismaClient,
  staffUserId: string,
  ip: string | null = null,
): Promise<{ locked: boolean }> {
  // Erst inkrementieren, dann lesen — atomar pro Statement.
  const updated = await prismaOwner.staffUser.update({
    where: { id: staffUserId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });

  // S-03: Ohne vertrauenswürdige Client-IP lässt sich ein verteilter Angriff
  // nicht von einem einzelnen anonymen Angreifer unterscheiden. Keine Sperre;
  // die kontogebundenen Rate-Limits begrenzen die Versuche.
  if (!isKnownClientIp(ip)) return { locked: false };

  const distinctIps = await countDistinctFailIps(staffUserId, ip);

  // Lock-Logik (IP bekannt):
  // - Wenn Redis verfügbar: lock erst bei ≥ N distinkten IPs.
  // - Wenn Redis aus: fallback auf reinen Failed-Count (alte Semantik).
  //   Verhindert dass ein Redis-Ausfall den Defense-Layer komplett
  //   deaktiviert.
  const shouldLock =
    distinctIps !== null
      ? distinctIps >= MAX_FAILED_LOGIN_ATTEMPTS
      : updated.failedLoginCount >= MAX_FAILED_LOGIN_ATTEMPTS;

  if (shouldLock) {
    await prismaOwner.staffUser.update({
      where: { id: staffUserId },
      data: {
        lockedUntil: new Date(Date.now() + LOCK_DURATION_MS),
        failedLoginCount: 0,
      },
    });
    await resetDistinctFailIps(staffUserId);
    return { locked: true };
  }
  return { locked: false };
}

/**
 * Setzt den Fehlversuchszähler bei erfolgreichem Passwort-Check zurück.
 * `lockedUntil` wird NICHT zurückgesetzt — eine aktive Sperre läuft regulär aus.
 */
export async function resetFailedLogin(
  prismaOwner: PrismaClient,
  staffUserId: string,
): Promise<void> {
  await prismaOwner.staffUser.update({
    where: { id: staffUserId },
    data: { failedLoginCount: 0 },
  });
  // L-4: Auch das Distinct-IP-Set zurücksetzen, sonst summieren sich IPs aus
  // legitimen Mehrfach-Logins (Office + Home + Mobil) über die Zeit auf.
  await resetDistinctFailIps(staffUserId);
}
