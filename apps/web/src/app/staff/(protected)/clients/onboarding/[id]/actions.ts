'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { portalBaseUrl } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { requestMagicLink } from '@/server/auth/magic-link';
import { enqueueDirectMailTx, kickMailOutboxDelivery } from '@/server/mail/outbox';
import { emitN8nEvent } from '@/server/n8n/emit';
import { generateInviteToken, INVITE_TTL_DAYS } from '@/server/gwg-onboarding/service';
import { prepareGwgInviteIssueTx } from '@/server/gwg-onboarding/invite-lifecycle';
import { prepareGwgInviteBindingTx } from '@/server/gwg-onboarding/invite-binding';
import { lockGwgCheckLifecycleTx } from '@/server/gwg/reverification';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { staffAction, ActionError, type ActionResult } from '@/server/actions/staff-action';
import { formDefault, parseFormData } from '@/server/actions/form-data';
import { isGwgProfessionallyReviewed } from '@/server/gwg/professional-review';
import { startManualGwgCaptureTx } from '@/server/gwg-onboarding/manual-capture';
import { audit } from '@/server/actions/audit';

export interface WizardResult {
  ok: boolean;
  error?: string;
}

/** Wie bisher: Gesamtmeldung aus allen Feldmeldungen, fehlende Felder als null. */
const ONBOARDING_FORM = {
  absentAsNull: true,
  errorMessage: (issues: readonly { message: string }[]) => issues.map((i) => i.message).join(', '),
} as const;

/** Navigationsparameter der Wizard-Schritte (Mandanten-ID, Schrittname). */
const SKIP_PARAMS = {
  absentAsNull: true,
  errorMessage: 'Ungültige Parameter.',
} as const;
const WIZARD_CLIENT_ID = z.string().regex(/^[a-f0-9-]{36}$/);

// ---------------------------------------------------------------------------
// Schritt 2: Ansprechpartner + (optional) Portal-Magic-Link
// ---------------------------------------------------------------------------

const ContactSchema = z.object({
  clientId: z.string().uuid(),
  email: z.string().email().max(255),
  fullName: z.string().min(2).max(200),
  phone: formDefault('', z.string().max(50).optional().or(z.literal(''))),
  role: formDefault('', z.string().max(80).optional().or(z.literal(''))),
  sendPortalInvite: formDefault('', z.string().optional()),
});

export async function onboardingAddContactAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const outcome = await staffAction({
    run: async (g) => {
      const { tenantId, ctx } = g;

      const parsed = parseFormData(ContactSchema, formData, ONBOARDING_FORM);
      if (!parsed.ok) return parsed;

      const sendInvite =
        parsed.data.sendPortalInvite === 'on' || parsed.data.sendPortalInvite === '1';

      const result = await withTenantContext(ctx, async (tx) => {
        const client = await tx.client.findUnique({
          where: { id: parsed.data.clientId },
          select: { allowActive: true },
        });
        if (!client) throw new ActionError('Mandant nicht gefunden.');
        await assertClientAccessTx(tx, g.session, parsed.data.clientId);

        const existing = await tx.clientContact.findFirst({
          where: {
            tenantId,
            clientId: parsed.data.clientId,
            email: parsed.data.email.toLowerCase(),
          },
        });
        if (existing) {
          await tx.clientContact.update({
            where: { id: existing.id },
            data: {
              fullName: parsed.data.fullName,
              phone: parsed.data.phone?.trim() || null,
              role: parsed.data.role?.trim() || null,
              active: true,
              // ACCESS-TENANT-RLS-001: A restored account needs a new calendar URL.
              ...(!existing.active ? { icalTokenVersion: { increment: 1 } } : {}),
            },
          });
          await audit(tx, g, {
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
        await audit(tx, g, {
          action: 'client_contact.create',
          resourceType: 'client_contact',
          resourceId: c.id,
          after: { email: parsed.data.email, onboarding: true },
        });
        return { id: c.id, email: c.email, allowActive: client.allowActive };
      });
      const contactId = result.id;
      const contactEmail = result.email;
      const clientAllowsPortal = result.allowActive;

      if (sendInvite && clientAllowsPortal) {
        try {
          await requestMagicLink({ tenantId, email: contactEmail, contactId });
        } catch {
          // Mailversand-Fehler nicht blockierend — Wizard läuft weiter, Berater kann später nachversenden
        }
      }
      return { clientId: parsed.data.clientId };
    },
  });
  if (!outcome.ok) return outcome;
  redirect(`/staff/clients/onboarding/${outcome.clientId}?step=gwg`);
}

// ---------------------------------------------------------------------------
// Schritt 3: GwG-Onboarding-Invite
// ---------------------------------------------------------------------------

const GwgSchema = z.object({
  clientId: z.string().uuid(),
  inviteName: z.string().min(2).max(200),
  inviteEmail: z.string().email().max(255),
  expectedLatestInviteId: z.string().uuid().optional().or(z.literal('')).nullable(),
});

export async function onboardingSendGwgAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const outcome = await staffAction({
    run: async (g) => {
      const { tenantId, staffId, ctx } = g;

      const parsed = parseFormData(GwgSchema, formData, ONBOARDING_FORM);
      if (!parsed.ok) return parsed;

      const { raw, hash } = generateInviteToken();
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
      const link = `${portalBaseUrl}/gwg-onboarding?token=${encodeURIComponent(raw)}`;

      const issuedInvite = await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, g.session, parsed.data.clientId);
        await lockGwgCheckLifecycleTx(tx, { tenantId, clientId: parsed.data.clientId });
        const latestInvite = await tx.gwgOnboardingInvite.findFirst({
          where: { tenantId, clientId: parsed.data.clientId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if ((latestInvite?.id ?? '') !== (parsed.data.expectedLatestInviteId || '')) {
          throw new ActionError(
            'Die Einladung wurde bereits geändert oder versendet. Bitte laden Sie den Schritt neu.',
          );
        }
        const binding = await prepareGwgInviteBindingTx(tx, {
          tenantId,
          clientId: parsed.data.clientId,
          bindLatestDraft: true,
        });
        if (!binding.ok) throw new ActionError(binding.error);
        const issue = await prepareGwgInviteIssueTx(tx, {
          tenantId,
          clientId: parsed.data.clientId,
          cancelledByStaff: staffId,
        });
        const inv = await tx.gwgOnboardingInvite.create({
          data: {
            tenantId,
            clientId: parsed.data.clientId,
            inviteName: parsed.data.inviteName,
            inviteEmail: parsed.data.inviteEmail,
            tokenHash: hash,
            expiresAt,
            createdByStaff: staffId,
            createdAt: issue.createdAt,
            gwgCheckId: binding.gwgCheckId,
            boundCheckRevision: binding.boundCheckRevision,
            boundClientRevision: binding.boundClientRevision,
          },
        });
        await audit(tx, g, {
          action: 'gwg.onboarding.invite',
          resourceType: 'gwg_onboarding_invite',
          resourceId: inv.id,
          after: {
            inviteEmail: parsed.data.inviteEmail,
            expiresAt: expiresAt.toISOString(),
            onboarding: true,
            gwgCheckId: binding.gwgCheckId,
            boundCheckRevision: binding.boundCheckRevision,
            boundClientRevision: binding.boundClientRevision,
            supersededInviteCount: issue.supersededInviteCount,
          },
        });
        // F-08: Einladungsmail im selben Commit als Versandauftrag; der Link mit
        // Token liegt nur Secret-Box-verschlüsselt im Auftrag.
        await enqueueDirectMailTx(
          tx,
          {
            tenantId,
            clientId: parsed.data.clientId,
            purpose: 'gwg-invite',
            resource: { type: 'gwg_onboarding_invite', id: inv.id },
            staffHref: `/staff/clients/onboarding/${parsed.data.clientId}`,
          },
          {
            slug: 'gwg-onboarding',
            to: parsed.data.inviteEmail,
            vars: {
              inviteName: parsed.data.inviteName,
              inviteEmail: parsed.data.inviteEmail,
              clientId: parsed.data.clientId,
              gwgInviteId: inv.id,
            },
            secretVars: { link },
            fallback: {
              subject: 'Identifizierung für Ihre Mandantschaft',
              bodyMd:
                'Sehr geehrte/r {{inviteName}},\n\nbitte identifizieren Sie sich über folgenden Link: {{link}}',
            },
          },
        );
        return { id: inv.id, gwgCheckId: binding.gwgCheckId };
      });
      const inviteId = issuedInvite.id;

      kickMailOutboxDelivery();
      await emitN8nEvent(
        'gwg.invite.created',
        {
          tenantId,
          clientId: parsed.data.clientId,
          gwgInviteId: inviteId,
          gwgCheckId: issuedInvite.gwgCheckId,
        },
        { tenantId },
      );
      return { clientId: parsed.data.clientId };
    },
  });
  if (!outcome.ok) return outcome;
  redirect(`/staff/clients/onboarding/${outcome.clientId}?step=poa`);
}

// ---------------------------------------------------------------------------
// Skip-Action: zum nächsten Schritt springen (für optionale Schritte)
// ---------------------------------------------------------------------------

export async function onboardingCaptureGwgInOfficeAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const outcome = await staffAction({
    run: async (guard) => {
      const parsed = parseFormData(z.object({ clientId: z.string().uuid() }), formData);
      if (!parsed.ok) return { ok: false, error: 'Ungültiger Mandant.' };
      const { clientId } = parsed.data;
      await withTenantContext(guard.ctx, async (tx) => {
        await assertClientAccessTx(tx, guard.session, clientId);
        await startManualGwgCaptureTx(tx, {
          tenantId: guard.tenantId,
          clientId,
          staffId: guard.staffId,
        });
      });
      revalidatePath(`/staff/clients/onboarding/${clientId}`);
      revalidatePath(`/staff/clients/${clientId}/gwg`);
      return { clientId };
    },
  });
  if (!outcome.ok) return outcome;
  redirect(`/staff/clients/${outcome.clientId}/gwg?from=onboarding`);
}

export async function onboardingSkipAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const outcome = await staffAction({
    run: async () => {
      const parsed = parseFormData(
        z.object({ clientId: WIZARD_CLIENT_ID, next: z.string().regex(/^[a-z_]+$/) }),
        formData,
        SKIP_PARAMS,
      );
      if (!parsed.ok) return parsed;
      return { clientId: parsed.data.clientId, next: parsed.data.next };
    },
  });
  if (!outcome.ok) return outcome;
  redirect(`/staff/clients/onboarding/${outcome.clientId}?step=${outcome.next}`);
}

// ---------------------------------------------------------------------------
// Schritt "done": Onboarding abschließen
// ---------------------------------------------------------------------------

export async function onboardingCompleteAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const outcome = await staffAction({
    run: async (g) => {
      const { staffId, ctx } = g;
      const parsed = parseFormData(z.object({ clientId: WIZARD_CLIENT_ID }), formData, SKIP_PARAMS);
      if (!parsed.ok) return parsed;
      const { clientId } = parsed.data;

      await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, g.session, clientId);
        const client = await tx.client.findUnique({
          where: { id: clientId },
          select: { allowActive: true, onboardingCompletedAt: true },
        });
        if (!client) throw new ActionError('Mandant nicht gefunden.');

        // Idempotent: ein erneuter Klick darf den historischen Abschlusszeitpunkt
        // nicht verändern und benötigt auch keine erneute GwG-Prüfung.
        if (client.onboardingCompletedAt) return;

        const [latestCheck, activeContacts] = await Promise.all([
          tx.gwgCheck.findFirst({
            where: { clientId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              id: true,
              status: true,
              validUntil: true,
              verifiedAt: true,
              verifiedBy: true,
              reviewSubmittedAt: true,
              reviewSubmittedBy: true,
            },
          }),
          tx.clientContact.count({ where: { clientId, active: true } }),
        ]);
        if (activeContacts === 0) {
          throw new ActionError(
            'Das Onboarding kann erst mit mindestens einem aktiven Ansprechpartner abgeschlossen werden.',
          );
        }
        if (!client.allowActive || !latestCheck || !isGwgProfessionallyReviewed(latestCheck)) {
          throw new ActionError(
            'Das Onboarding kann erst nach einer ausdrücklich eingereichten und durch den verantwortlichen Berufsträger dokumentierten GwG-Freigabe abgeschlossen werden.',
          );
        }

        const completedAt = new Date();
        const claim = await tx.client.updateMany({
          where: { id: clientId, allowActive: true, onboardingCompletedAt: null },
          data: { onboardingCompletedAt: completedAt, onboardingCompletedBy: staffId },
        });
        if (claim.count === 0) {
          const current = await tx.client.findUnique({
            where: { id: clientId },
            select: { onboardingCompletedAt: true },
          });
          // Gleichzeitiger Doppelklick: der Gewinner hat Marker und Audit bereits
          // geschrieben. Der zweite Aufruf bleibt ohne doppelten Nachweis idempotent.
          if (current?.onboardingCompletedAt) return;
          throw new ActionError(
            'Der Mandantenstatus hat sich parallel geändert. Bitte Onboarding neu laden.',
          );
        }
        await audit(tx, g, {
          action: 'client.onboarding.complete',
          resourceType: 'client',
          resourceId: clientId,
          after: { onboardingCompletedAt: completedAt.toISOString(), gwgCheckId: latestCheck.id },
        });
      });

      revalidatePath('/staff/clients');
      revalidatePath(`/staff/clients/${clientId}`);
      return { clientId };
    },
  });
  if (!outcome.ok) return outcome;
  redirect(`/staff/clients/${outcome.clientId}`);
}
