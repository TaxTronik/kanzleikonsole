'use server';

import { redirect } from 'next/navigation';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { z } from 'zod';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

function redirectWithError(message: string): never {
  redirect(`/staff/clients/new?error=${encodeURIComponent(message)}`);
}

const createClientSchema = z.object({
  name: z.string().min(1, 'Name ist Pflichtfeld'),
  kind: z.enum(['NATPERS', 'JURPERS', 'PERSGES']),
  datevNo: z.string().optional(),
  street: z.string().max(200).optional().or(z.literal('')),
  postalCode: z.string().max(20).optional().or(z.literal('')),
  city: z.string().max(100).optional().or(z.literal('')),
  countryIso: z.string().length(2).optional().or(z.literal('')),
  vatId: z.string().max(50).optional().or(z.literal('')),
  invoiceEmail: z.string().email().max(255).optional().or(z.literal('')),
  berufstraegerIds: z.array(z.string().uuid()).min(1, 'Mindestens ein Berufsträger ist Pflicht.'),
  hauptbearbeiterIds: z.array(z.string().uuid()),
});

export async function createClientAction(formData: FormData) {
  const g = await staffActionGuard();
  if (!g.ok) redirect('/staff/login'); // redirect wirft (never) — bleibt außerhalb try/catch
  const { tenantId, staffId, ctx, session } = g;
  // Mandanten-Anlage berührt Stammdaten + GwG-Schranke (allow_active) — nur ADMIN/PARTNER.
  if (!isStaffAdmin(session)) {
    throw new ActionError('Nur ADMIN/PARTNER darf neue Mandanten anlegen.');
  }

  const parsed = createClientSchema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    datevNo: formData.get('datevNo') || undefined,
    street: formData.get('street') ?? '',
    postalCode: formData.get('postalCode') ?? '',
    city: formData.get('city') ?? '',
    countryIso: ((formData.get('countryIso') as string) ?? '').toUpperCase(),
    vatId: formData.get('vatId') ?? '',
    invoiceEmail: formData.get('invoiceEmail') ?? '',
    berufstraegerIds: formData.getAll('berufstraegerIds').map(String),
    hauptbearbeiterIds: formData.getAll('hauptbearbeiterIds').map(String),
  });

  if (!parsed.success) {
    redirectWithError(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const {
    name,
    kind,
    datevNo,
    street,
    postalCode,
    city,
    countryIso,
    vatId,
    invoiceEmail,
    berufstraegerIds,
    hauptbearbeiterIds,
  } = parsed.data;

  let clientId: string;
  try {
    clientId = await withTenantContext(ctx, async (tx) => {
      const assignedStaffIds = Array.from(new Set([...berufstraegerIds, ...hauptbearbeiterIds]));
      const activeStaffCount = await tx.staffUser.count({
        where: { tenantId, id: { in: assignedStaffIds }, active: true },
      });
      if (activeStaffCount !== assignedStaffIds.length) {
        throw new ActionError('Eine gewählte Zuständigkeit ist nicht mehr aktiv.');
      }

      const client = await tx.client.create({
        data: {
          tenantId,
          name,
          kind,
          datevNo: datevNo ?? null,
          allowActive: false,
          street: street || null,
          postalCode: postalCode || null,
          city: city || null,
          countryIso: countryIso || null,
          vatId: vatId || null,
          invoiceEmail: invoiceEmail || null,
        },
      });

      for (const sid of berufstraegerIds) {
        await tx.clientResponsibility.create({
          data: { tenantId, clientId: client.id, staffId: sid, role: 'BERUFSTRAEGER' },
        });
      }
      for (const sid of hauptbearbeiterIds) {
        await tx.clientResponsibility.create({
          data: { tenantId, clientId: client.id, staffId: sid, role: 'HAUPTBEARBEITER' },
        });
      }

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client.created',
        resourceType: 'client',
        resourceId: client.id,
        after: {
          name,
          kind,
          datevNo: datevNo ?? null,
          hasAddress: !!(street && city),
          berufstraegerIds,
          hauptbearbeiterIds,
        },
      });

      return client.id;
    });
  } catch (e) {
    if (e instanceof ActionError) redirectWithError(e.message);
    throw e;
  }

  redirect(`/staff/clients/${clientId}`);
}
