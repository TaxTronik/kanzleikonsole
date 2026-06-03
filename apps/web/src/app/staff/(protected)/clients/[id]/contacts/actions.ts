'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { requestMagicLink } from '@/server/auth/magic-link';
import { revokeAllSessions } from '@/server/auth/revocation';
import { toActionError } from '@/server/auth/rbac';
import { withStaff, staffActionGuard, ActionError } from '@/server/actions/staff-action';

const InviteSchema = z.object({
  clientId: z.string().uuid(),
  email: z.string().email().max(255),
  fullName: z.string().min(2).max(200),
  phone: z.string().max(50).optional(),
  role: z.string().max(80).optional(),
  sendInvite: z.enum(['1', 'on', 'true']).optional(),
});

export interface ActionResult {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

export async function inviteContactAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // staffActionGuard: Magic-Link-Versand ist ein Post-Commit-Side-Effect
  // (braucht tenantId + die im Tx ermittelte E-Mail).
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = InviteSchema.safeParse({
    clientId: formData.get('clientId'),
    email: formData.get('email'),
    fullName: formData.get('fullName'),
    phone: (formData.get('phone') as string | null) || undefined,
    role: (formData.get('role') as string | null) || undefined,
    sendInvite: formData.get('sendInvite') ?? undefined,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path.join('.')] = issue.message;
    }
    return { ok: false, error: 'Validierungsfehler.', fieldErrors };
  }

  const { clientId, email, fullName, phone, role, sendInvite } = parsed.data;
  const phoneClean = phone?.trim() || null;
  const roleClean = role?.trim() || null;

  let contactEmail: string;
  try {
    contactEmail = await withTenantContext(ctx, async (tx) => {
      // existiert ein aktiver Kontakt schon?
      const existing = await tx.clientContact.findFirst({
        where: { tenantId, email: email.toLowerCase() },
      });
      if (existing) {
        if (existing.clientId !== clientId) {
          throw new ActionError('E-Mail bereits einem anderen Mandanten zugeordnet.');
        }
        await tx.clientContact.update({
          where: { id: existing.id },
          data: { fullName, phone: phoneClean, role: roleClean, active: true },
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
        return existing.email;
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
      return contact.email;
    });
  } catch (e) {
    return toActionError(e);
  }

  if (sendInvite) {
    await requestMagicLink({ tenantId, email: contactEmail });
  }

  revalidatePath(`/staff/clients/${clientId}`);
  return { ok: true };
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
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { contactId, clientId, fullName } = parsed.data;
  const email = parsed.data.email.toLowerCase();
  const phone = parsed.data.phone?.trim() || null;
  const role = parsed.data.role?.trim() || null;

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const before = await tx.clientContact.findUnique({
        where: { id: contactId },
        select: { fullName: true, email: true, phone: true, role: true, clientId: true },
      });
      if (!before) throw new ActionError('Ansprechpartner nicht gefunden.');
      if (before.clientId !== clientId) throw new ActionError('Mandant stimmt nicht überein.');
      // E-Mail ist die Portal-Login-Identität: bei Änderung dieselbe
      // Uniqueness-Regel wie bei der Einladung — keine Dublette innerhalb
      // des Tenants, nicht auf einen anderen Mandanten zeigend.
      if (email !== before.email) {
        const clash = await tx.clientContact.findFirst({
          where: { tenantId, email, id: { not: contactId } },
          select: { clientId: true },
        });
        if (clash) {
          throw new ActionError(
            clash.clientId === clientId
              ? 'E-Mail bereits einem anderen Ansprechpartner dieses Mandanten zugeordnet.'
              : 'E-Mail bereits einem anderen Mandanten zugeordnet.',
          );
        }
      }
      await tx.clientContact.update({
        where: { id: contactId },
        data: { fullName, email, phone, role },
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
    },
    { revalidate: `/staff/clients/${clientId}` },
  );
}

export async function deactivateContactAction(formData: FormData): Promise<void> {
  const g = await staffActionGuard();
  if (!g.ok) return; // void-Action: bei fehlender Auth still abbrechen (wie zuvor)
  const { ctx } = g;

  // S2: UUID-Validation für beide IDs.
  const parsed = z
    .object({ contactId: z.string().uuid(), clientId: z.string().uuid() })
    .safeParse({ contactId: formData.get('contactId'), clientId: formData.get('clientId') });
  if (!parsed.success) return;
  const { contactId, clientId } = parsed.data;

  await withTenantContext(ctx, async (tx) => {
    await tx.clientContact.update({
      where: { id: contactId },
      data: { active: false },
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

  // N-2: Aktive Portal-Sessions sofort revoken. portalAuth prüft den iat-Claim
  // gegen den Revocation-Timestamp in Redis — sonst bliebe der JWT-Cookie eines
  // deaktivierten Kontakts bis 24 h gültig.
  await revokeAllSessions('portal', contactId);

  revalidatePath(`/staff/clients/${clientId}`);
}
