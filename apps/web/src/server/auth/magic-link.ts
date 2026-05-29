// =============================================================================
// Magic-Link-Service
//
// - generateMagicLink(tenantId, email): erzeugt rohen Token (32 Bytes b64url),
//   speichert SHA-256-Hash + Ablaufzeit in DB, gibt rohen Token zurück.
// - verifyMagicLink(token): hashed Token, sucht zugehörigen Eintrag, prüft
//   Gültigkeit/Verbrauch, markiert als consumed, gibt zugehörigen ClientContact
//   zurück (oder null).
//
// Hinweis: rohen Token NIE persistieren — nur per Mail an den User.
// =============================================================================

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { env, portalBaseUrl } from '@taxtronik/config';
import { prismaOwner } from '@/server/db/prisma-owner';
import { withTenantContext } from '@taxtronik/db';
import { notify } from '@/server/notifications/service';
import { log } from '@/server/logger';
import { checkRateLimit } from '@/server/rate-limit';

const MAGIC_LINK_TTL_MINUTES = 30;

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Erzeugt einen Magic-Link für (tenantId, email) und sendet die Mail.
 * Findet kein Contact existiert, gibt nicht-fail zurück (anti-enumeration).
 */
export async function requestMagicLink(input: {
  tenantId: string;
  email: string;
}): Promise<{ ok: boolean }> {
  // N-9: Throttle pro (tenantId, email), auch wenn requestMagicLink intern aus
  // einem authentifizierten Staff-Flow (z. B. inviteContactAction) heraus
  // aufgerufen wird. Verhindert Mail-Bombing von Kontakten durch einen
  // kompromittierten/missbräuchlichen Staff-Account. Symmetrisch zum Limit
  // in der öffentlichen requestMagicLinkAction.
  //
  // UX-Note: Anti-Enumeration verlangt, dass wir bei Drosselung weiterhin
  // ok:true zurückgeben — sonst könnte ein Angreifer durch Probieren
  // herausfinden, welche E-Mails existieren. Konsequenz: ein Staff, der die
  // „Login-Link senden"-Aktion doppelt klickt, sieht zweimal Erfolg, aber die
  // zweite Mail wird stillschweigend nicht versendet. Im Staff-UI sollte die
  // Schaltfläche nach dem ersten Klick deshalb mind. 60 s disabled bleiben.
  const emailKey = input.email.toLowerCase();
  const rl = await checkRateLimit(`magic-link-issue:${input.tenantId}:${emailKey}`, {
    max: 1,
    windowSec: 60,
  });
  if (!rl.ok) {
    return { ok: true };
  }

  const tenant = await prismaOwner.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) return { ok: true };

  const contact = await prismaOwner.clientContact.findFirst({
    where: { tenantId: input.tenantId, email: input.email.toLowerCase(), active: true },
  });
  if (!contact) {
    // M-4: Anti-Enumeration UND Anti-Timing-Side-Channel. Bei existierender
    // E-Mail folgt nun DB-Write + SMTP-Send (~100-500ms); bei nicht-existierender
    // E-Mail sollten wir eine vergleichbare Latenz simulieren, sonst lässt sich
    // mit Stoppuhr enumerieren. Wir warten zufällig 250-500ms (typische Range
    // für DB+SMTP in On-Prem-Setups). crypto.randomInt statt Math.random —
    // Math.random ist nicht kryptographisch und die Verteilung könnte später
    // versehentlich für etwas Sicherheitsrelevantes wiederverwendet werden.
    const dummyDelay = 250 + randomInt(0, 250);
    await new Promise((resolve) => setTimeout(resolve, dummyDelay));
    return { ok: true };
  }

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000);

  await prismaOwner.magicLink.create({
    data: {
      tenantId: input.tenantId,
      email: contact.email,
      tokenHash,
      expiresAt,
    },
  });

  const link = `${portalBaseUrl}/portal/login/verify?token=${encodeURIComponent(rawToken)}`;

  // Dev-Convenience: Link zusätzlich ins Server-Log schreiben, damit man auch
  // ohne funktionierende SMTP-Anbindung (z. B. blockierter Port 1025) ins
  // Portal einsteigen kann. In Production NICHT — der Klartext-Token darf
  // dort die Anwendung nicht verlassen.
  if (env.NODE_ENV !== 'production') {
    // L-3 + L1/NEW7: Strukturiertes Log statt console.log. Property-Name
    // bewusst `devSignInUrl` statt `link`, weil Pino-Redact `*.link`
    // global verschluckt (Defense in Depth gegen Token-Leak im Prod-Log).
    // Hier ist explizit gewollt, dass der URL im Dev sichtbar ist.
    log.info(
      {
        email: contact.email,
        devSignInUrl: link,
        expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      },
      'magic-link (DEV) — direkt einloggen über den Link',
    );
  }

  // M-3: SMTP-Fehler dürfen die Anti-Enumeration-Garantie nicht brechen.
  // Vorher: throw e in Production hätte den Caller mit einer Exception
  // beworfen, die anders zurückkommt als die schweigende „kein Contact"-
  // Variante (250-500ms-Delay + ok:true). Ein Angreifer mit Stoppuhr und
  // simultaner SMTP-Störung könnte daraus den Account-Existenz-Status ableiten.
  // Jetzt: SMTP-Fehler immer schlucken + strukturiert loggen. Token bleibt
  // in der DB, der User bekommt halt keinen Link — Resend-Pfad ist gangbar.
  // Operations sieht den Fehler im Log UND als In-App-Notification (unten).
  try {
    await sendTemplateMail({
      tenantId: contact.tenantId,
      slug: 'magic-link',
      to: contact.email,
      vars: {
        contact: { fullName: contact.fullName, email: contact.email },
        tenant: { name: tenant.name },
        link,
        expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      },
      fallback: {
        subject: 'Ihr Login-Link zum Mandantenportal',
        bodyMd: `Hallo {{contact.fullName}},\n\nüber den folgenden Link können Sie sich in das Mandantenportal einloggen:\n\n{{link}}\n\nDer Link ist {{expiresMinutes}} Minuten gültig und kann nur einmal verwendet werden.`,
      },
    });
  } catch (e) {
    // Production: error-Level, damit Ops das Monitoring abgreift. KEIN throw —
    // Anti-Enumeration ist wichtiger als der eine fehlgeschlagene Send.
    log[env.NODE_ENV === 'production' ? 'error' : 'warn'](
      { err: (e as Error).message, email: contact.email },
      'magic-link: SMTP-Versand fehlgeschlagen — Token bleibt gültig, Resend möglich',
    );
    // In-App-Notification an die Kanzlei: der Kontakt hat seinen Login-Link
    // NICHT erhalten — Staff kann nachfassen / erneut senden. Best-effort in
    // eigenem try/catch: ein Notification-Fehler darf weder den Flow brechen
    // noch die Anti-Enumeration-Garantie (immer ok:true) verletzen.
    // Idempotent pro Kontakt (resourceId) — wiederholte Fehler spammen nicht.
    try {
      await withTenantContext(
        { tenantId: contact.tenantId, actorId: null, actorType: 'SYSTEM' },
        (tx) =>
          notify(tx, {
            tenantId: contact.tenantId,
            staffId: null,
            kind: 'SYSTEM_MAIL_FAILED',
            title: 'Login-Link konnte nicht versendet werden',
            body: `Der Magic-Link an ${contact.email} wurde nicht zugestellt (SMTP-Fehler). Bitte Mailserver prüfen oder den Link erneut senden.`,
            resourceType: 'client_contact',
            resourceId: contact.id,
          }),
      );
    } catch (notifyErr) {
      log.error(
        { err: (notifyErr as Error).message, email: contact.email },
        'magic-link: Notification über SMTP-Fehler konnte nicht angelegt werden',
      );
    }
  }

  return { ok: true };
}

/**
 * Verifiziert einen Magic-Link-Token und gibt ClientContact + tenant zurück.
 * Markiert Token als consumed (one-time-use).
 */
export async function verifyMagicLink(rawToken: string): Promise<{
  contact: { id: string; tenantId: string; clientId: string; email: string; fullName: string };
} | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const tokenHash = hashToken(rawToken);

  const link = await prismaOwner.magicLink.findFirst({
    where: { tokenHash },
  });
  if (!link) return null;
  if (link.consumedAt) return null;
  if (link.expiresAt < new Date()) return null;

  const contact = await prismaOwner.clientContact.findFirst({
    where: { tenantId: link.tenantId, email: link.email, active: true },
  });
  if (!contact) return null;

  // Atomar als consumed markieren (Race-Schutz)
  const claim = await prismaOwner.magicLink.updateMany({
    where: { id: link.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claim.count !== 1) return null;

  // Last-Login-Timestamp updaten (fire-and-forget)
  prismaOwner.clientContact
    .update({ where: { id: contact.id }, data: { lastLoginAt: new Date() } })
    .catch(() => void 0);

  return {
    contact: {
      id: contact.id,
      tenantId: contact.tenantId,
      clientId: contact.clientId,
      email: contact.email,
      fullName: contact.fullName,
    },
  };
}
