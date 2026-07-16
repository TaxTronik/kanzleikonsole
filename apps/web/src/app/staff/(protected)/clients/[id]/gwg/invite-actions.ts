'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { portalBaseUrl } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { emitN8nEvent } from '@/server/n8n/emit';
import { generateInviteToken, INVITE_TTL_DAYS } from '@/server/gwg-onboarding/service';
import { prepareGwgInviteIssueTx } from '@/server/gwg-onboarding/invite-lifecycle';
import { prepareGwgInviteBindingTx } from '@/server/gwg-onboarding/invite-binding';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
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
  gwgCheckId: z.string().uuid().optional(),
});

export async function sendInviteAction(input: {
  clientId: string;
  inviteName: string;
  inviteEmail: string;
  gwgCheckId?: string;
}): Promise<InviteResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;
  const parsed = SendSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { clientId, inviteName, inviteEmail, gwgCheckId } = parsed.data;

  const { raw, hash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  let issuedInvite: { id: string; gwgCheckId: string | null };
  try {
    issuedInvite = await withTenantContext(ctx, async (tx) => {
      // U-6: clientId Tenant-Sanity — letzte unverschlossene Stelle aus
      // R-2 / S-6-Sammelfund.
      await assertClientAccessTx(tx, session, clientId);
      await assertClientInTenant(tx, clientId);
      const binding = await prepareGwgInviteBindingTx(tx, {
        tenantId,
        clientId,
        requestedCheckId: gwgCheckId,
        bindLatestDraft: false,
      });
      if (!binding.ok) throw new ActionError(binding.error);
      const issue = await prepareGwgInviteIssueTx(tx, {
        tenantId,
        clientId,
        cancelledByStaff: staffId,
      });
      const inv = await tx.gwgOnboardingInvite.create({
        data: {
          tenantId,
          clientId,
          inviteName,
          inviteEmail,
          tokenHash: hash,
          expiresAt,
          createdByStaff: staffId,
          createdAt: issue.createdAt,
          gwgCheckId: binding.gwgCheckId,
          boundCheckRevision: binding.boundCheckRevision,
          boundClientRevision: binding.boundClientRevision,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'gwg.onboarding.invite',
        resourceType: 'gwg_onboarding_invite',
        resourceId: inv.id,
        after: {
          inviteName,
          inviteEmail,
          expiresAt: expiresAt.toISOString(),
          gwgCheckId: binding.gwgCheckId,
          boundCheckRevision: binding.boundCheckRevision,
          boundClientRevision: binding.boundClientRevision,
          supersededInviteCount: issue.supersededInviteCount,
        },
      });
      return { id: inv.id, gwgCheckId: binding.gwgCheckId };
    });
  } catch (e) {
    return toActionError(e);
  }

  const link = `${portalBaseUrl}/gwg-onboarding?token=${encodeURIComponent(raw)}`;
  await emitN8nEvent(
    'gwg.invite.created',
    {
      tenantId,
      clientId,
      gwgInviteId: issuedInvite.id,
      gwgCheckId: issuedInvite.gwgCheckId,
    },
    { tenantId },
  );

  // Befund 3: fire-and-forget mit catch+Log statt `void ….catch(() => void 0)`
  // (Fehler wurden vorher stillschweigend verschluckt).
  fireAndForget(
    'sendTemplateMail (gwg-onboarding invite)',
    sendTemplateMail({
      tenantId,
      clientId,
      slug: 'gwg-onboarding',
      to: inviteEmail,
      vars: { inviteName, inviteEmail, link, clientId, gwgInviteId: issuedInvite.id },
      fallback: {
        subject: 'Identifizierung für Ihre Mandantschaft',
        bodyMd:
          'Sehr geehrte/r {{inviteName}},\n\num Sie als Mandant aufzunehmen, sind wir gesetzlich verpflichtet, Ihre Identität nach dem Geldwäschegesetz zu prüfen.\n\nBitte füllen Sie das kurze Online-Formular über folgenden Link aus:\n\n{{link}}\n\nDer Link ist 14 Tage gültig.',
      },
    }),
  );

  revalidatePath(`/staff/clients/${clientId}/gwg`);
  return { ok: true, link };
}

export async function cancelInviteAction(input: { id: string }): Promise<InviteResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const inv = await tx.gwgOnboardingInvite.findUnique({ where: { id: parsed.data.id } });
    if (!inv) return;
    await assertClientAccessTx(tx, session, inv.clientId);
    await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: inv.clientId });
    const current = await tx.gwgOnboardingInvite.findUnique({ where: { id: parsed.data.id } });
    if (!current) return;
    if (current.status === 'SUBMITTED')
      throw new ActionError('Bereits abgeschickt — kann nicht zurückgezogen werden.');
    if (current.status !== 'PENDING' && current.status !== 'STARTED') return;
    const cancelled = await tx.gwgOnboardingInvite.updateMany({
      where: {
        id: parsed.data.id,
        status: { in: ['PENDING', 'STARTED'] },
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByStaff: staffId,
        // Token-Hash entwerten, damit der Link sofort tot ist
        tokenHash: '',
      },
    });
    if (cancelled.count === 0) {
      throw new ActionError('Einladungsstatus wurde parallel geändert — bitte Seite neu laden.');
    }
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'gwg.onboarding.cancel',
      resourceType: 'gwg_onboarding_invite',
      resourceId: parsed.data.id,
      before: { status: current.status },
      after: { status: 'CANCELLED' },
    });
  });

  // Wir kennen die clientId hier nur via DB — revalidatePath generisch
  if (r.ok) revalidatePath('/staff/clients', 'layout');
  return r;
}
