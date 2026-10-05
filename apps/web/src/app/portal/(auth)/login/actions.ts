'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safePortalReturnTo } from './verify/safe-return-to';
import { requestMagicLink, verifyMagicLink } from '@/server/auth/magic-link';
import { writePortalSession } from '@/server/auth/portal-session';
import { checkMagicLinkEntryLimit } from '@/server/auth/magic-link-entry';
import { prismaOwner } from '@/server/db/prisma-owner';
import { checkIpOrGlobalLimit, emailRateLimitKey, getClientIp } from '@/server/rate-limit';
import { parseFormData } from '@/server/actions/form-data';

const MAGIC_LINK_REQUEST_LIMIT = { max: 5, windowSec: 900 };
/**
 * S-03: Ohne Client-IP deckelt diese Versandobergrenze die Login-Mails aller
 * Self-Service-Anfragen. 100 je 15 min entspricht der bisherigen globalen
 * Quote, zählt aber nur tatsächlich versendete Mails: Ausschöpfen verlangt
 * mindestens 20 verschiedene existierende Portal-Adressen (je Adresse höchstens
 * fünf Anfragen je 15 min) statt beliebiger Anfragen.
 */
const MAGIC_LINK_MAIL_CEILING_WITHOUT_IP = { max: 100, windowSec: 900 };

const RequestSchema = z.object({
  email: z.string().email(),
  tenantSlug: z.string().min(1).max(100).default('default'),
  // Rücksprungziel aus dem Proxy-Redirect (?returnTo=…); wird bis in die
  // Magic-Link-URL durchgereicht und überall via safePortalReturnTo geerdet.
  returnTo: z.string().max(500).optional().or(z.literal('')),
});

export interface RequestLinkResult {
  ok: boolean;
  error?: string;
}

export async function requestMagicLinkAction(
  _prev: RequestLinkResult | null,
  formData: FormData,
): Promise<RequestLinkResult> {
  const parsed = parseFormData(RequestSchema, formData);
  if (!parsed.ok) {
    return { ok: false, error: 'Bitte gültige E-Mail-Adresse eingeben.' };
  }

  // Rate-Limit (S-03) — Per-IP 5/15 min, wenn die IP bekannt ist, und immer
  // 5/15 min pro E-Mail-Hash, damit weder rotierende IPs noch fehlende
  // Client-IPs zu einem gemeinsamen, billig erschöpfbaren Zähler führen. Der
  // Schlüssel entsteht vor jedem Lookup, existierende und unbekannte Adressen
  // werden identisch gedrosselt (gleiche Meldung, kein Enumerations-Orakel).
  const ip = getClientIp(await headers());
  const rl = await checkIpOrGlobalLimit('portal-magic', ip, MAGIC_LINK_REQUEST_LIMIT, {
    key: emailRateLimitKey(parsed.data.email),
    limit: MAGIC_LINK_REQUEST_LIMIT,
  });
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Anfragen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }

  const tenant = await prismaOwner.tenant.findFirst({
    where: { slug: parsed.data.tenantSlug },
  });
  if (!tenant) {
    // Anti-Enumeration: gleicher Erfolgshinweis wie bei gültigem Tenant
    return { ok: true };
  }

  const returnTo = safePortalReturnTo(parsed.data.returnTo || undefined);
  await requestMagicLink({
    tenantId: tenant.id,
    email: parsed.data.email,
    returnTo: returnTo === '/portal/dashboard' ? undefined : returnTo,
    ...(ip ? {} : { mailCeiling: MAGIC_LINK_MAIL_CEILING_WITHOUT_IP }),
  });
  return { ok: true };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  rateLimited?: boolean;
}

export async function verifyMagicLinkAction(
  token: string,
  contactId?: string,
): Promise<VerifyResult> {
  if (!token) return { ok: false, error: 'Token fehlt.' };

  const limit = await checkMagicLinkEntryLimit(await headers(), 'verify');
  if (!limit.ok) {
    return {
      ok: false,
      rateLimited: true,
      error: 'Zu viele Bestätigungsversuche. Bitte kurz warten.',
    };
  }

  const result = await verifyMagicLink(token, contactId);
  if (!result) return { ok: false, error: 'Link ungültig oder abgelaufen.' };

  await writePortalSession(result.contact);

  return { ok: true };
}

/**
 * Form-Action für die Verify-Seite. Der Magic-Link-Token wird NUR hier
 * (expliziter POST-Klick) konsumiert — niemals beim bloßen GET-Render der
 * Seite. Damit verbrauchen E-Mail-Security-Scanner / Link-Prefetcher
 * (Outlook SafeLinks, Mimecast, Virenfilter) den One-Time-Token nicht
 * mehr vorab, und ein Doppel-Render der Server-Component ist harmlos.
 */
export async function confirmMagicLinkAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const contactId = String(formData.get('contactId') ?? '') || undefined;
  const returnTo = safePortalReturnTo((formData.get('returnTo') as string | null) ?? undefined);
  const r = await verifyMagicLinkAction(token, contactId);
  // redirect() wirft NEXT_REDIRECT — muss AUSSERHALB des try/catch von
  // verifyMagicLinkAction laufen (tut es hier).
  redirect(
    r.ok ? returnTo : `/portal/login/verify?status=${r.rateLimited ? 'rate-limited' : 'invalid'}`,
  );
}
