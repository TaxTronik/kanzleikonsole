'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { requestMagicLink } from '@/server/auth/magic-link';
import { revokeAllSessions } from '@/server/auth/revocation';
import { assertClientAccessTx } from '@/server/auth/rbac';
import {
  withStaff,
  staffAction,
  ActionError,
  parseFormData,
  type ActionResult,
} from '@/server/actions/staff-action';

const InviteSchema = z.object({
  clientId: z.string().uuid(),
  email: z.string().email().max(255),
  fullName: z.string().min(2).max(200),
  phone: z.string().max(50).optional(),
  role: z.string().max(80).optional(),
  sendInvite: z.enum(['1', 'on', 'true']).optional(),
});

export async function inviteContactAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // staffAction: Magic-Link-Versand ist ein Post-Commit-Side-Effect
  // (braucht tenantId + die im Tx ermittelte E-Mail).
  return staffAction({
    run: async ({ tenantId, staffId, ctx, session }) => {
      const parsed = parseFormData(InviteSchema, formData);
      if (!parsed.ok) return parsed;

      const { clientId, email, fullName, phone, role, sendInvite } = parsed.data;
      const phoneClean = phone?.trim() || null;
      const roleClean = role?.trim() || null;

      const result = await withTenantContext(ctx, async (tx) => {
        await assertClientAccessTx(tx, session, clientId);
        // existiert dieser Kontakt bei diesem Mandanten schon?
        const existing = await tx.clientContact.findFirst({
          where: { tenantId, clientId, email: email.toLowerCase() },
        });
        if (existing) {
          await tx.clientContact.update({
            where: { id: existing.id },
            data: {
              fullName,
              phone: phoneClean,
              role: roleClean,
              active: true,
              // ACCESS-TENANT-RLS-001: Reactivating a previously disabled contact
              // must not restore calendar capabilities issued before revocation.
              ...(!existing.active ? { icalTokenVersion: { increment: 1 } } : {}),
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'client_contact.update',
            resourceType: 'client_contact',
            resourceId: existing.id,
            after: { email, fullName, phone: phoneClean, role: roleClean, clientId },
          });
          return { id: existing.id, email: existing.email };
        }
        const contact = await tx.clientContact.create({
          data: {
            tenantId,
            clientId,
            email: email.toLowerCase(),
            fullName,
            phone: phoneClean,
            role: roleClean,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'client_contact.create',
          resourceType: 'client_contact',
          resourceId: contact.id,
          after: { email: contact.email, fullName, phone: phoneClean, role: roleClean, clientId },
        });
        return { id: contact.id, email: contact.email };
      });
      const contactId = result.id;
      const contactEmail = result.email;

      if (sendInvite) {
        await requestMagicLink({ tenantId, email: contactEmail, contactId });
      }

      revalidatePath(`/staff/clients/${clientId}`);
    },
  });
}

const UpdateSchema = z.object({
  contactId: z.string().uuid(),
  clientId: z.string().uuid(),
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(255),
  phone: z.string().max(50).nullable().optional(),
  role: z.string().max(80).nullable().optional(),
});

export async function updateContactAction(
  input: z.infer<typeof UpdateSchema>,
): Promise<ActionResult> {
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path.join('.') || '_form';
      (fieldErrors[field] ??= []).push(issue.message);
    }
    return {
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors,
    };
  }
  const { contactId, clientId, fullName } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const phone = parsed.data.phone?.trim() || null;
  const role = parsed.data.role?.trim() || null;

  const result = await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const before = await tx.clientContact.findUnique({
        where: { id: contactId },
        select: { fullName: true, email: true, phone: true, role: true, clientId: true },
      });
      if (!before) throw new ActionError('Ansprechpartner nicht gefunden.');
      if (before.clientId !== clientId) throw new ActionError('Mandant stimmt nicht überein.');
      await assertClientAccessTx(tx, session, before.clientId);
      // E-Mail ist die Portal-Login-Identität: bei Änderung dieselbe
      // Uniqueness-Regel wie bei der Einladung — keine Dublette innerhalb
      // des Tenants, nicht auf einen anderen Mandanten zeigend.
      const emailChanged = email !== before.email.trim().toLowerCase();
      if (emailChanged) {
        const clash = await tx.clientContact.findFirst({
          where: { tenantId, clientId, email, id: { not: contactId } },
          select: { clientId: true },
        });
        if (clash) {
          throw new ActionError(
            'E-Mail bereits einem anderen Ansprechpartner dieses Mandanten zugeordnet.',
          );
        }
        await revokeAllSessions('portal', contactId);
      }
      await tx.clientContact.update({
        where: { id: contactId },
        data: {
          fullName,
          email,
          phone,
          role,
          // lastLoginAt dient zugleich als Nachweis, dass genau diese
          // Login-Adresse bereits verwendet wurde. Nach einem Adresswechsel
          // darf dieser Nachweis nicht auf die neue E-Mail übergehen.
          // iCal URLs authenticate independently of session cookies and email.
          ...(emailChanged ? { lastLoginAt: null, icalTokenVersion: { increment: 1 } } : {}),
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client_contact.update',
        resourceType: 'client_contact',
        resourceId: contactId,
        before,
        after: { fullName, email, phone, role },
      });
      return { emailChanged };
    },
    { revalidate: `/staff/clients/${clientId}` },
  );

  if (!result.ok) return result;
  return { ok: true };
}

const RotateIcalSchema = z.object({
  contactId: z.string().uuid(),
  clientId: z.string().uuid(),
});

/**
 * Widerruft alle iCal-Feed-URLs eines Kontakts: icalTokenVersion geht in den
 * Feed-Token-HMAC ein (server/ical/feed.ts), die Route vergleicht die Version
 * gegen den DB-Stand — der Increment entwertet jede ausgegebene URL. Der
 * Mandant muss den Kalender im Portal neu abonnieren.
 */
export async function rotateIcalTokenAction(
  input: z.infer<typeof RotateIcalSchema>,
): Promise<ActionResult> {
  return staffAction({
    run: async (g) => {
      const { ctx, session } = g;

      const parsed = RotateIcalSchema.safeParse(input);
      if (!parsed.success)
        return { ok: false, error: 'Ungültiger Kontakt.', errorCode: 'VALIDATION_ERROR' };
      const { contactId, clientId } = parsed.data;

      await withTenantContext(ctx, async (tx) => {
        const contact = await tx.clientContact.findUnique({
          where: { id: contactId },
          select: { clientId: true },
        });
        if (!contact) throw new ActionError('Ansprechpartner nicht gefunden.');
        if (contact.clientId !== clientId) throw new ActionError('Mandant stimmt nicht überein.');
        await assertClientAccessTx(tx, session, contact.clientId);
        const updated = await tx.clientContact.update({
          where: { id: contactId },
          data: { icalTokenVersion: { increment: 1 } },
          select: { icalTokenVersion: true },
        });
        await evidenceService.record(tx, {
          tenantId: g.tenantId,
          actorType: 'STAFF',
          actorId: g.staffId,
          action: 'client_contact.ical_rotate',
          resourceType: 'client_contact',
          resourceId: contactId,
          after: { icalTokenVersion: updated.icalTokenVersion },
        });
      });

      revalidatePath(`/staff/clients/${clientId}`);
    },
  });
}

export async function deactivateContactAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    run: async (g) => {
      const { ctx, session } = g;

      // S2: UUID-Validation für beide IDs.
      const parsed = parseFormData(
        z.object({ contactId: z.string().uuid(), clientId: z.string().uuid() }),
        formData,
      );
      if (!parsed.ok) return parsed;
      const { contactId, clientId } = parsed.data;

      await withTenantContext(ctx, async (tx) => {
        const contact = await tx.clientContact.findUnique({
          where: { id: contactId },
          select: { clientId: true },
        });
        if (!contact) throw new ActionError('Ansprechpartner nicht gefunden.');
        if (contact.clientId !== clientId) throw new ActionError('Mandant stimmt nicht überein.');
        await assertClientAccessTx(tx, session, contact.clientId);
        await revokeAllSessions('portal', contactId);
        await tx.clientContact.update({
          where: { id: contactId },
          data: { active: false, icalTokenVersion: { increment: 1 } },
        });
        await evidenceService.record(tx, {
          tenantId: g.tenantId,
          actorType: 'STAFF',
          actorId: g.staffId,
          action: 'client_contact.deactivate',
          resourceType: 'client_contact',
          resourceId: contactId,
        });
      });

      revalidatePath(`/staff/clients/${clientId}`);
    },
  });
}
