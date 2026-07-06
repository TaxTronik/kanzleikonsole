'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { portalBaseUrl } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { requestMagicLink } from '@/server/auth/magic-link';
import { sendTemplateMail } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { generateInviteToken, INVITE_TTL_DAYS } from '@/server/gwg-onboarding/service';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

export interface WizardResult { ok: boolean; error?: string; }

function redirectToContact(clientId: string, error?: string): never {
  const suffix = error ? `&error=${encodeURIComponent(error)}` : '';
  redirect(`/staff/clients/onboarding/${clientId}?step=contact${suffix}`);
}

// ---------------------------------------------------------------------------
// Schritt 2: Ansprechpartner + (optional) Portal-Magic-Link
// ---------------------------------------------------------------------------

const ContactSchema = z.object({
  clientId: z.string().uuid(),
  email: z.string().email().max(255),
  fullName: z.string().min(2).max(200),
  phone: z.string().max(50).optional().or(z.literal('')),
  role: z.string().max(80).optional().or(z.literal('')),
  sendPortalInvite: z.string().optional(),
});

export async function onboardingAddContactAction(formData: FormData) {
  const g = await staffActionGuard();
  if (!g.ok) redirect('/staff/login'); // redirect wirft (never) — außerhalb try/catch
  const { tenantId, staffId, ctx } = g;
  const rawClientId = typeof formData.get('clientId') === 'string' ? String(formData.get('clientId')) : '';

  const parsed = ContactSchema.safeParse({
    clientId: formData.get('clientId'),
    email: formData.get('email'),
    fullName: formData.get('fullName'),
    phone: formData.get('phone') ?? '',
    role: formData.get('role') ?? '',
    sendPortalInvite: formData.get('sendPortalInvite') ?? '',
  });
  if (!parsed.success) {
    if (/^[a-f0-9-]{36}$/.test(rawClientId)) {
      redirectToContact(rawClientId, parsed.error.issues.map((i) => i.message).join(', '));
    }
    throw new ActionError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const sendInvite = parsed.data.sendPortalInvite === 'on' || parsed.data.sendPortalInvite === '1';

  let contactEmail: string;
  let contactId: string;
  let clientAllowsPortal: boolean;
  try {
    const result = await withTenantContext(ctx, async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: parsed.data.clientId },
        select: { allowActive: true },
      });
      if (!client) throw new ActionError('Mandant nicht gefunden.');
      await assertClientAccessTx(tx, g.session, parsed.data.clientId);

      const existing = await tx.clientContact.findFirst({
        where: { tenantId, clientId: parsed.data.clientId, email: parsed.data.email.toLowerCase() },
      });
      if (existing) {
        await tx.clientContact.update({
          where: { id: existing.id },
          data: {
            fullName: parsed.data.fullName,
            phone: parsed.data.phone?.trim() || null,
            role: parsed.data.role?.trim() || null,
            active: true,
          },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'client_contact.update',
          resourceType: 'client_contact',
          resourceId: existing.id,
          after: { onboarding: true },
        });
        return { id: existing.id, email: existing.email, allowActive: client.allowActive };
      }

      const c = await tx.clientContact.create({
        data: {
          tenantId,
          clientId: parsed.data.clientId,
          email: parsed.data.email.toLowerCase(),
          fullName: parsed.data.fullName,
          phone: parsed.data.phone?.trim() || null,
          role: parsed.data.role?.trim() || null,
        },
      });
      await evidenceService.record(tx, {
        tenantId, actorType: 'STAFF', actorId: staffId,
        action: 'client_contact.create',
        resourceType: 'client_contact',
        resourceId: c.id,
        after: { email: parsed.data.email, onboarding: true },
      });
      return { id: c.id, email: c.email, allowActive: client.allowActive };
    });
    contactId = result.id;
    contactEmail = result.email;
    clientAllowsPortal = result.allowActive;
  } catch (e) {
    if (e instanceof ActionError) redirectToContact(parsed.data.clientId, e.message);
    throw e;
  }

  if (sendInvite && clientAllowsPortal) {
    try {
      await requestMagicLink({ tenantId, email: contactEmail, contactId });
    } catch {
      // Mailversand-Fehler nicht blockierend — Wizard läuft weiter, Berater kann später nachversenden
    }
  }

  redirect(`/staff/clients/onboarding/${parsed.data.clientId}?step=gwg`);
}

// ---------------------------------------------------------------------------
// Schritt 3: GwG-Onboarding-Invite
// ---------------------------------------------------------------------------

const GwgSchema = z.object({
  clientId: z.string().uuid(),
  inviteName: z.string().min(2).max(200),
  inviteEmail: z.string().email().max(255),
});

export async function onboardingSendGwgAction(formData: FormData) {
  const g = await staffActionGuard();
  if (!g.ok) redirect('/staff/login'); // redirect wirft (never) — außerhalb try/catch
  const { tenantId, staffId, ctx } = g;

  const parsed = GwgSchema.safeParse({
    clientId: formData.get('clientId'),
    inviteName: formData.get('inviteName'),
    inviteEmail: formData.get('inviteEmail'),
  });
  if (!parsed.success) {
    throw new ActionError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { raw, hash } = generateInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const inviteId = await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, g.session, parsed.data.clientId);
    const inv = await tx.gwgOnboardingInvite.create({
      data: {
        tenantId,
        clientId: parsed.data.clientId,
        inviteName: parsed.data.inviteName,
        inviteEmail: parsed.data.inviteEmail,
        tokenHash: hash,
        expiresAt,
        createdByStaff: staffId,
      },
    });
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'gwg.onboarding.invite',
      resourceType: 'gwg_onboarding_invite',
      resourceId: inv.id,
      after: {
        inviteEmail: parsed.data.inviteEmail,
        expiresAt: expiresAt.toISOString(),
        onboarding: true,
      },
    });
    return inv.id;
  });

  const link = `${portalBaseUrl}/gwg-onboarding?token=${encodeURIComponent(raw)}`;
  // Befund 3: fire-and-forget mit catch+Log statt `void ….catch(() => void 0)`.
  fireAndForget('sendTemplateMail (gwg-onboarding wizard)', sendTemplateMail({
    tenantId,
    slug: 'gwg-onboarding',
    to: parsed.data.inviteEmail,
    vars: {
      inviteName: parsed.data.inviteName,
      inviteEmail: parsed.data.inviteEmail,
      link,
      clientId: parsed.data.clientId,
      gwgInviteId: inviteId,
    },
    n8nEvent: 'client.created',
    n8nPayload: {
      tenantId,
      clientId: parsed.data.clientId,
      gwgInviteId: inviteId,
      inviteEmail: parsed.data.inviteEmail,
      inviteName: parsed.data.inviteName,
      link,
      kind: 'gwg-onboarding',
    },
    fallback: {
      subject: 'Identifizierung für Ihre Mandantschaft',
      bodyMd: 'Sehr geehrte/r {{inviteName}},\n\nbitte identifizieren Sie sich über folgenden Link: {{link}}',
    },
  }));

  redirect(`/staff/clients/onboarding/${parsed.data.clientId}?step=poa`);
}

// ---------------------------------------------------------------------------
// Skip-Action: zum nächsten Schritt springen (für optionale Schritte)
// ---------------------------------------------------------------------------

export async function onboardingSkipAction(formData: FormData) {
  const g = await staffActionGuard();
  if (!g.ok) redirect('/staff/login'); // redirect wirft (never)
  const clientId = formData.get('clientId');
  const next = formData.get('next');
  if (typeof clientId !== 'string' || typeof next !== 'string') {
    throw new ActionError('Ungültige Parameter.');
  }
  if (!/^[a-f0-9-]{36}$/.test(clientId) || !/^[a-z_]+$/.test(next)) {
    throw new ActionError('Ungültige Parameter.');
  }
  redirect(`/staff/clients/onboarding/${clientId}?step=${next}`);
}

// ---------------------------------------------------------------------------
// Schritt "done": Onboarding abschließen
// ---------------------------------------------------------------------------

export async function onboardingCompleteAction(formData: FormData) {
  const g = await staffActionGuard();
  if (!g.ok) redirect('/staff/login'); // redirect wirft (never) — außerhalb try/catch
  const { tenantId, staffId, ctx } = g;
  const clientId = formData.get('clientId');
  if (typeof clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(clientId)) {
    throw new ActionError('Ungültige Parameter.');
  }

  await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, g.session, clientId);
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'client.onboarding.complete',
      resourceType: 'client',
      resourceId: clientId,
    });
  });

  redirect(`/staff/clients/${clientId}`);
}
