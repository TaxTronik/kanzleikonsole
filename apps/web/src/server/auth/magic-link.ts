import { createHash, randomBytes, randomInt } from 'node:crypto';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { env, portalBaseUrl } from '@taxtronik/config';
import { prismaOwner } from '@/server/db/prisma-owner';
import { evidenceService } from '@/server/container';
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

type MagicLinkContact = {
  id: string;
  tenantId: string;
  clientId: string;
  email: string;
  fullName: string;
  client: { name: string; allowActive: boolean; anonymizedAt: Date | null };
};

async function antiTimingDelay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 250 + randomInt(0, 250)));
}

async function sendOneMagicLink(input: {
  tenantName: string;
  contact: MagicLinkContact;
}): Promise<void> {
  const { tenantName, contact } = input;
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000);

  await prismaOwner.magicLink.create({
    data: {
      tenantId: contact.tenantId,
      contactId: contact.id,
      email: contact.email,
      tokenHash,
      expiresAt,
    },
  });

  const link = `${portalBaseUrl}/portal/login/verify?token=${encodeURIComponent(rawToken)}`;

  if (env.NODE_ENV !== 'production') {
    log.info(
      {
        email: contact.email,
        contactId: contact.id,
        clientId: contact.clientId,
        devSignInUrl: link,
        expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      },
      'magic-link (DEV) - direkt einloggen ueber den Link',
    );
  }

  try {
    const mailResult = await sendTemplateMail({
      tenantId: contact.tenantId,
      slug: 'magic-link',
      to: contact.email,
      vars: {
        contact: { fullName: contact.fullName, email: contact.email },
        tenant: { name: tenantName },
        client: { name: contact.client.name },
        link,
        expiresMinutes: MAGIC_LINK_TTL_MINUTES,
      },
      fallback: {
        subject: `Ihr Login-Link zum Mandantenportal (${contact.client.name})`,
        bodyMd: `Hallo {{contact.fullName}},\n\nüber den folgenden Link können Sie sich in das Mandantenportal für {{client.name}} einloggen:\n\n{{link}}\n\nDer Link ist {{expiresMinutes}} Minuten gültig und kann nur einmal verwendet werden.`,
      },
    });
    if (!mailResult.ok) {
      throw new Error('template mail returned ok=false');
    }
  } catch (e) {
    log[env.NODE_ENV === 'production' ? 'error' : 'warn'](
      { err: (e as Error).message, email: contact.email, contactId: contact.id },
      'magic-link: SMTP-Versand fehlgeschlagen - Token wird invalidiert',
    );
    if (env.NODE_ENV === 'production') {
      try {
        await prismaOwner.magicLink.deleteMany({
          where: { tokenHash, consumedAt: null },
        });
      } catch (deleteErr) {
        log.error(
          { err: (deleteErr as Error).message, email: contact.email, contactId: contact.id },
          'magic-link: Token nach SMTP-Fehler konnte nicht invalidiert werden',
        );
      }
    }
    try {
      await withTenantContext(
        { tenantId: contact.tenantId, actorId: null, actorType: 'SYSTEM' },
        (tx) =>
          notify(tx, {
            tenantId: contact.tenantId,
            staffId: null,
            kind: 'SYSTEM_MAIL_FAILED',
            title: 'Login-Link konnte nicht versendet werden',
            body: `Der Magic-Link an ${contact.email} wurde nicht zugestellt (SMTP-Fehler). Bitte Mailserver pruefen oder den Link erneut senden.`,
            resourceType: 'client_contact',
            resourceId: contact.id,
          }),
      );
    } catch (notifyErr) {
      log.error(
        { err: (notifyErr as Error).message, email: contact.email, contactId: contact.id },
        'magic-link: Notification ueber SMTP-Fehler konnte nicht angelegt werden',
      );
    }
  }
}

/**
 * Erzeugt Magic-Links fuer eine E-Mail-Adresse. Bei Staff-Flows wird per
 * contactId exakt der gewuenschte Ansprechpartner adressiert. Ohne contactId
 * (Portal-Login per E-Mail) bekommen alle aktiven Kontakte dieser Adresse
 * einen eigenen, kontaktgebundenen Link.
 */
export async function requestMagicLink(input: {
  tenantId: string;
  email: string;
  contactId?: string;
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

  const contacts = (
    input.contactId
      ? await prismaOwner.clientContact.findMany({
          where: { id: input.contactId, tenantId: input.tenantId, email: emailKey, active: true },
          include: { client: { select: { name: true, allowActive: true, anonymizedAt: true } } },
          orderBy: { createdAt: 'asc' },
        })
      : await prismaOwner.clientContact.findMany({
          where: { tenantId: input.tenantId, email: emailKey, active: true },
          include: { client: { select: { name: true, allowActive: true, anonymizedAt: true } } },
          orderBy: { createdAt: 'asc' },
        })
  ) as MagicLinkContact[];

  const eligibleContacts = contacts.filter(
    (contact) => contact.client.allowActive && contact.client.anonymizedAt === null,
  );
  if (eligibleContacts.length === 0) {
    await antiTimingDelay();
    return { ok: true };
  }

  for (const contact of eligibleContacts) {
    await sendOneMagicLink({ tenantName: tenant.name, contact });
  }

  return { ok: true };
}

/**
 * Verifiziert einen Magic-Link-Token und gibt den gebundenen ClientContact
 * zurueck. Legacy-Links ohne contactId verwenden den alten tenant/email-Fallback.
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

  const contact = (
    link.contactId
      ? await prismaOwner.clientContact.findUnique({
          where: { id: link.contactId },
          include: { client: { select: { allowActive: true, anonymizedAt: true } } },
        })
      : await prismaOwner.clientContact.findFirst({
          where: { tenantId: link.tenantId, email: link.email, active: true },
          include: { client: { select: { allowActive: true, anonymizedAt: true } } },
        })
  ) as
    | (Omit<MagicLinkContact, 'client'> & {
        active: boolean;
        client: { allowActive: boolean; anonymizedAt: Date | null };
      })
    | null;

  if (
    !contact ||
    !contact.active ||
    contact.tenantId !== link.tenantId ||
    contact.email.toLowerCase() !== link.email.toLowerCase() ||
    !contact.client.allowActive ||
    contact.client.anonymizedAt !== null
  ) {
    return null;
  }

  const claimed = await prismaOwner.$transaction(async (tx) => {
    const claim = await tx.magicLink.updateMany({
      where: { id: link.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claim.count !== 1) return false;
    await evidenceService.record(tx, {
      tenantId: link.tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: contact.id,
      action: 'auth.magic_link.consume',
      resourceType: 'client_contact',
      resourceId: contact.id,
      after: { email: contact.email },
    });
    return true;
  });
  if (!claimed) return null;

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
