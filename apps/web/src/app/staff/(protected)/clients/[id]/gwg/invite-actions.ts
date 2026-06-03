'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { portalBaseUrl } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { generateInviteToken, INVITE_TTL_DAYS } from '@/server/gwg-onboarding/service';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { toActionError } from '@/server/auth/rbac';
import { staffActionGuard, withStaff, ActionError } from '@/server/actions/staff-action';

export interface InviteResult {
  ok: boolean;
  error?: string;
  link?: string;
}

const SendSchema = z.object({
  clientId: z.string().uuid(),
  inviteName: z.string().min(2).max(200),
  inviteEmail: z.string().email().max(255),
});

export async function sendInviteAction(input: {
  clientId: string;
  inviteName: string;
  inviteEmail: string;
}): Promise<InviteResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;
  const parsed = SendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { clientId, inviteName, inviteEmail } = parsed.data;

  const { raw, hash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  let inviteId: string;
  try {
    inviteId = await withTenantContext(ctx, async (tx) => {
      // U-6: clientId Tenant-Sanity — letzte unverschlossene Stelle aus
      // R-2 / S-6-Sammelfund.
      await assertClientInTenant(tx, clientId);
      const inv = await tx.gwgOnboardingInvite.create({
        data: {
          tenantId,
          clientId,
          inviteName,
          inviteEmail,
          tokenHash: hash,
          expiresAt,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.onboarding.invite',
        resourceType: 'gwg_onboarding_invite',
        resourceId: inv.id,
        after: { inviteName, inviteEmail, expiresAt: expiresAt.toISOString() },
      });
      return inv.id;
    });
  } catch (e) {
    return toActionError(e);
  }

  const link = `${portalBaseUrl}/gwg-onboarding?token=${encodeURIComponent(raw)}`;

  void sendTemplateMail({
    tenantId,
    slug: 'gwg-onboarding',
    to: inviteEmail,
    vars: { inviteName, inviteEmail, link, clientId, gwgInviteId: inviteId },
    n8nEvent: 'client.created',
    n8nPayload: {
      tenantId,
      clientId,
      gwgInviteId: inviteId,
      inviteEmail,
      inviteName,
      link,
      kind: 'gwg-onboarding',
    },
    fallback: {
      subject: 'Identifizierung für Ihre Mandantschaft',
      bodyMd: 'Sehr geehrte/r {{inviteName}},\n\num Sie als Mandant aufzunehmen, sind wir gesetzlich verpflichtet, Ihre Identität nach dem Geldwäschegesetz zu prüfen.\n\nBitte füllen Sie das kurze Online-Formular über folgenden Link aus:\n\n{{link}}\n\nDer Link ist 14 Tage gültig.',
    },
  }).catch(() => void 0);

  revalidatePath(`/staff/clients/${clientId}/gwg`);
  return { ok: true, link };
}

export async function cancelInviteAction(input: { id: string }): Promise<InviteResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inv = await tx.gwgOnboardingInvite.findUnique({ where: { id: parsed.data.id } });
    if (!inv) return;
    if (inv.status === 'SUBMITTED') throw new ActionError('Bereits abgeschickt — kann nicht zurückgezogen werden.');
    await tx.gwgOnboardingInvite.update({
      where: { id: parsed.data.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByStaff: staffId,
        // Token-Hash entwerten, damit der Link sofort tot ist
        tokenHash: '',
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.onboarding.cancel',
      resourceType: 'gwg_onboarding_invite',
      resourceId: parsed.data.id,
      before: { status: inv.status },
      after: { status: 'CANCELLED' },
    });
  });

  // Wir kennen die clientId hier nur via DB — revalidatePath generisch
  if (r.ok) revalidatePath('/staff/clients', 'layout');
  return r;
}
