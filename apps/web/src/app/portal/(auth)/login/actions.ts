'use server';

import { z } from 'zod';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { safePortalReturnTo } from './verify/safe-return-to';
import { requestMagicLink, verifyMagicLink } from '@/server/auth/magic-link';
import { writePortalSession } from '@/server/auth/portal-session';
import { prismaOwner } from '@/server/db/prisma-owner';
import { checkIpOrGlobalLimit, getClientIp } from '@/server/rate-limit';

const RequestSchema = z.object({
  email: z.string().email(),
  tenantSlug: z.string().min(1).max(100).default('default'),
});

export interface RequestLinkResult {
  ok: boolean;
  error?: string;
}

export async function requestMagicLinkAction(
  _prev: RequestLinkResult | null,
  formData: FormData,
): Promise<RequestLinkResult> {
  // Rate-Limit — Per-IP 5/15min wenn bekannt, sonst globaler Sturm-Bucket.
  const ip = getClientIp(await headers());
  const rl = await checkIpOrGlobalLimit(
    'portal-magic',
    ip,
    { max: 5, windowSec: 900 },
    { max: 100, windowSec: 900 },
  );
  if (!rl.ok) {
    return {
      ok: false,
      error: `Zu viele Anfragen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.`,
    };
  }

  const parsed = RequestSchema.safeParse({
    email: formData.get('email'),
    tenantSlug: formData.get('tenantSlug') ?? 'default',
  });
  if (!parsed.success) {
    return { ok: false, error: 'Bitte gültige E-Mail-Adresse eingeben.' };
  }

  const tenant = await prismaOwner.tenant.findFirst({
    where: { slug: parsed.data.tenantSlug },
  });
  if (!tenant) {
    // Anti-Enumeration: gleicher Erfolgshinweis wie bei gültigem Tenant
    return { ok: true };
  }

  await requestMagicLink({ tenantId: tenant.id, email: parsed.data.email });
  return { ok: true };
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
}

export async function verifyMagicLinkAction(
  token: string,
  contactId?: string,
): Promise<VerifyResult> {
  if (!token) return { ok: false, error: 'Token fehlt.' };

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
  redirect(r.ok ? returnTo : '/portal/login/verify?status=invalid');
}
