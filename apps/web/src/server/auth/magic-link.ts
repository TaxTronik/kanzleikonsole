import { createHash, randomBytes, randomInt } from 'node:crypto';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { env, portalBaseUrl } from '@taxtronik/config';
import { prismaOwner } from '@/server/db/prisma-owner';
import { evidenceService } from '@/server/container';
import { withTenantContext } from '@taxtronik/db';
import { notifyMany } from '@/server/notifications/service';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { log } from '@/server/logger';
import { checkRateLimit } from '@/server/rate-limit';
import { filterStaffAccessClientTx } from '@/server/auth/rbac';
import { findEligiblePortalProfilesByEmail, type PortalProfileOption } from './portal-profiles';

const MAGIC_LINK_TTL_MINUTES = 30;

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(32).toString('base64url');
}

async function antiTimingDelay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 250 + randomInt(0, 250)));
}

async function sendMagicLink(input: {
  tenantId: string;
  tenantName: string;
  recipient: PortalProfileOption;
  contactId: string | null;
  profileCount: number;
  returnTo?: string;
}): Promise<void> {
  const { tenantId, tenantName, recipient, contactId, profileCount, returnTo } = input;
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000);

  await prismaOwner.magicLink.create({
    data: {
      tenantId,
      contactId,
      email: recipient.email,
      tokenHash,
      expiresAt,
    },
  });

  // returnTo (Deeplink vor dem Login, z. B. Anforderungs-Detail) wird an die
  // Verify-URL angehängt; die Verify-Seite und confirmMagicLinkAction erden
  // den Wert erneut über safePortalReturnTo (nur /portal/…-Pfade).
  const returnToSuffix =
    returnTo && returnTo.startsWith('/portal/') ? `&returnTo=${encodeURIComponent(returnTo)}` : '';
  const link = `${portalBaseUrl}/portal/login/verify?token=${encodeURIComponent(rawToken)}${returnToSuffix}`;

  if (env.NODE_ENV !== 'production') {
    log.info(
      {
        email: recipient.email,
        contactId,
        clientId: contactId ? recipient.clientId : null,
        profileCount,
        devSignInUrl: link,
        expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      },
      'magic-link (DEV) - direkt einloggen ueber den Link',
    );
  }

  try {
    const mailResult = await sendTemplateMail({
      tenantId,
      slug: 'magic-link',
      to: recipient.email,
      subjectSuffix: profileCount > 1 ? `${profileCount} Mandantenprofile` : recipient.clientName,
      vars: {
        contact: { fullName: recipient.contactName, email: recipient.email },
        tenant: { name: tenantName },
        client: {
          name:
            profileCount > 1 ? `${profileCount} verfügbare Mandantenprofile` : recipient.clientName,
        },
        profileCount,
        link,
        expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      },
      fallback: {
        subject: 'Ihr Login-Link zum Mandantenportal',
        bodyMd:
          profileCount > 1
            ? 'Hallo {{contact.fullName}},\n\nüber den folgenden Link wählen Sie aus, welches Ihrer {{profileCount}} Mandantenprofile Sie öffnen möchten:\n\n{{link}}\n\nDer Link ist {{expiresMinutes}} Minuten gültig und kann nur einmal verwendet werden.'
            : 'Hallo {{contact.fullName}},\n\nüber den folgenden Link können Sie sich in das Mandantenportal für {{client.name}} einloggen:\n\n{{link}}\n\nDer Link ist {{expiresMinutes}} Minuten gültig und kann nur einmal verwendet werden.',
      },
    });
    if (!mailResult.ok) {
      throw new Error('template mail returned ok=false');
    }
    try {
      await withTenantContext({ tenantId, actorId: null, actorType: 'SYSTEM' }, (tx) =>
        resolveNotificationsTx(tx, {
          tenantId,
          resources: [{ resourceType: 'client_contact', resourceId: recipient.contactId }],
          kinds: ['SYSTEM_MAIL_FAILED'],
        }),
      );
    } catch (resolveErr) {
      // Der Login-Link wurde erfolgreich versendet; ein reines Glocken-
      // Housekeeping darf den gültigen Token nicht nachträglich invalidieren.
      log.warn(
        { err: (resolveErr as Error).message, contactId: recipient.contactId },
        'magic-link: alte Mailfehler-Notification konnte nicht geschlossen werden',
      );
    }
  } catch (e) {
    log[env.NODE_ENV === 'production' ? 'error' : 'warn'](
      {
        err: (e as Error).message,
        contactId: recipient.contactId,
        clientId: recipient.clientId,
      },
      'magic-link: SMTP-Versand fehlgeschlagen - Token wird invalidiert',
    );
    if (env.NODE_ENV === 'production') {
      try {
        await prismaOwner.magicLink.deleteMany({
          where: { tokenHash, consumedAt: null },
        });
      } catch (deleteErr) {
        log.error(
          {
            err: (deleteErr as Error).message,
            contactId: recipient.contactId,
            clientId: recipient.clientId,
          },
          'magic-link: Token nach SMTP-Fehler konnte nicht invalidiert werden',
        );
      }
    }
    try {
      await withTenantContext({ tenantId, actorId: null, actorType: 'SYSTEM' }, async (tx) => {
        const activeStaff = await tx.staffUser.findMany({
          where: { tenantId, active: true },
          select: { id: true },
        });
        const allowedStaff = await filterStaffAccessClientTx(
          tx,
          tenantId,
          activeStaff.map((staff) => staff.id),
          recipient.clientId,
        );
        if (allowedStaff.size === 0) {
          log.warn(
            { contactId: recipient.contactId, clientId: recipient.clientId },
            'magic-link: kein zugriffsberechtigter Empfaenger fuer SMTP-Fehler-Notification',
          );
          return;
        }
        await notifyMany(tx, [...allowedStaff], {
          tenantId,
          kind: 'SYSTEM_MAIL_FAILED',
          title: 'Login-Link konnte nicht versendet werden',
          body: `Der Magic-Link für ${recipient.contactName} (${recipient.clientName}) wurde nicht zugestellt (SMTP-Fehler). Bitte Mailserver prüfen oder den Link erneut senden.`,
          href: `/staff/clients/${recipient.clientId}`,
          resourceType: 'client_contact',
          resourceId: recipient.contactId,
        });
      });
    } catch (notifyErr) {
      log.error(
        {
          err: (notifyErr as Error).message,
          contactId: recipient.contactId,
          clientId: recipient.clientId,
        },
        'magic-link: Notification ueber SMTP-Fehler konnte nicht angelegt werden',
      );
    }
  }
}

/**
 * Erzeugt Magic-Links fuer eine E-Mail-Adresse. Bei Staff-Flows wird per
 * contactId exakt der gewuenschte Ansprechpartner adressiert. Beim Login im
 * Portal entsteht dagegen genau ein E-Mail-gebundener Link; nach dem Klick
 * waehlt der Nutzer explizit eines seiner aktiven Mandantenprofile aus.
 */
export async function requestMagicLink(input: {
  tenantId: string;
  email: string;
  contactId?: string;
  /** Optionaler /portal/…-Deeplink, auf dem der Nutzer nach dem Login landet. */
  returnTo?: string;
}): Promise<{ ok: boolean }> {
  const emailKey = input.email.toLowerCase();

  const rl = await checkRateLimit(`magic-link-issue:${input.tenantId}:${emailKey}`, {
    max: 1,
    windowSec: 60,
  });
  if (!rl.ok) {
    await antiTimingDelay();
    return { ok: true };
  }

  const tenant = await prismaOwner.tenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) {
    await antiTimingDelay();
    return { ok: true };
  }

  const profiles = await findEligiblePortalProfilesByEmail({
    tenantId: input.tenantId,
    email: emailKey,
  });
  const eligibleProfiles = input.contactId
    ? profiles.filter((profile) => profile.contactId === input.contactId)
    : profiles;
  if (eligibleProfiles.length === 0) {
    await antiTimingDelay();
    return { ok: true };
  }

  await sendMagicLink({
    tenantId: input.tenantId,
    tenantName: tenant.name,
    recipient: eligibleProfiles[0]!,
    contactId: input.contactId ? eligibleProfiles[0]!.contactId : null,
    profileCount: eligibleProfiles.length,
    returnTo: input.returnTo,
  });

  return { ok: true };
}

type UsableMagicLink = {
  id: string;
  tenantId: string;
  email: string;
  contactId: string | null;
};

async function findUsableMagicLink(rawToken: string): Promise<UsableMagicLink | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const link = await prismaOwner.magicLink.findFirst({
    where: { tokenHash: hashToken(rawToken) },
  });
  if (!link || link.consumedAt || link.expiresAt < new Date()) return null;
  return link;
}

async function profilesForLink(link: UsableMagicLink): Promise<PortalProfileOption[]> {
  const profiles = await findEligiblePortalProfilesByEmail({
    tenantId: link.tenantId,
    email: link.email,
  });
  return link.contactId
    ? profiles.filter((profile) => profile.contactId === link.contactId)
    : profiles;
}

export interface MagicLinkInspection {
  profiles: PortalProfileOption[];
}

/** Liest die sichere Profilauswahl, ohne den Einmal-Link zu konsumieren. */
export async function inspectMagicLink(rawToken: string): Promise<MagicLinkInspection | null> {
  const link = await findUsableMagicLink(rawToken);
  if (!link) return null;
  const profiles = await profilesForLink(link);
  return profiles.length > 0 ? { profiles } : null;
}

/**
 * Verifiziert einen Magic-Link-Token und gibt den gebundenen ClientContact
 * zurueck. Bei E-Mail-Links mit mehreren Profilen ist die explizite contactId
 * zwingend. Kontaktgebundene Staff-Links koennen nie auf ein anderes Profil
 * umgebogen werden.
 */
export async function verifyMagicLink(
  rawToken: string,
  selectedContactId?: string,
): Promise<{
  contact: { id: string; tenantId: string; clientId: string; email: string; fullName: string };
} | null> {
  const link = await findUsableMagicLink(rawToken);
  if (!link) return null;
  if (link.contactId && selectedContactId && selectedContactId !== link.contactId) return null;

  const profiles = await profilesForLink(link);
  const contactId =
    link.contactId ?? selectedContactId ?? (profiles.length === 1 ? profiles[0]!.contactId : null);
  if (!contactId) return null;
  const contact = profiles.find((profile) => profile.contactId === contactId);
  if (!contact) return null;

  const claimed = await prismaOwner.$transaction(async (tx) => {
    const claim = await tx.magicLink.updateMany({
      where: { id: link.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claim.count !== 1) return false;
    await evidenceService.record(tx, {
      tenantId: link.tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: contact.contactId,
      action: 'auth.magic_link.consume',
      resourceType: 'client_contact',
      resourceId: contact.contactId,
      after: { email: contact.email },
    });
    return true;
  });
  if (!claimed) return null;

  prismaOwner.clientContact
    .update({ where: { id: contact.contactId }, data: { lastLoginAt: new Date() } })
    .catch(() => void 0);

  return {
    contact: {
      id: contact.contactId,
      tenantId: link.tenantId,
      clientId: contact.clientId,
      email: contact.email,
      fullName: contact.contactName,
    },
  };
}
