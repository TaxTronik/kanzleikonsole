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
// =============================================================================

import type { PrismaClient } from '@prisma/client';
import { getRedis } from '@/server/redis';

export const MAX_FAILED_LOGIN_ATTEMPTS = 5;
export const LOCK_DURATION_MS = 30 * 60 * 1000;
const DISTINCT_IP_WINDOW_SEC = 30 * 60;

async function countDistinctFailIps(userId: string, ip: string | null): Promise<number | null> {
  const r = getRedis();
  if (!r) return null;
  // Wenn `getClientIp` keinen Header findet, gibt sie 'unknown' zurück. In dem
  // Fall können wir nicht zwischen Quell-IPs unterscheiden → fallback auf den
  // count-basierten Lockout (sonst würde eine Proxy-Fehlkonfiguration den
  // Lockout komplett deaktivieren).
  if (!ip || ip === 'unknown') return null;
  const key = `staff-fail-ips:${userId}`;
  try {
    await r.sadd(key, ip);
    await r.expire(key, DISTINCT_IP_WINDOW_SEC);
    const count = await r.scard(key);
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

async function resetDistinctFailIps(userId: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(`staff-fail-ips:${userId}`);
  } catch {
    console.warn('[lockout] Redis del für fail-ips fehlgeschlagen');
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

  const distinctIps = await countDistinctFailIps(staffUserId, ip);

  // Lock-Logik:
  // - Wenn Redis verfügbar und IP bekannt: lock erst bei ≥ N distinkten IPs.
  // - Wenn Redis aus oder IP unbekannt: fallback auf reinen Failed-Count
  //   (alte Semantik). Verhindert dass ein Redis-Ausfall den Defense-Layer
  //   komplett deaktiviert.
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
