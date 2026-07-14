'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { staffActionGuard, ActionError } from '@/server/actions/staff-action';

function redirectWithError(message: string): never {
  redirect(`/staff/clients/onboarding/new?error=${encodeURIComponent(message)}`);
}

const Schema = z.object({
  name: z.string().min(1, 'Name ist Pflichtfeld').max(200),
  kind: z.enum(['NATPERS', 'JURPERS', 'PERSGES']),
  datevNo: z.string().max(40).optional().or(z.literal('')),
  addisonNo: z.string().max(40).optional().or(z.literal('')),
  street: z.string().max(200).optional().or(z.literal('')),
  postalCode: z.string().max(20).optional().or(z.literal('')),
  city: z.string().max(100).optional().or(z.literal('')),
  countryIso: z.string().length(2).optional().or(z.literal('')),
  vatId: z.string().max(50).optional().or(z.literal('')),
  invoiceEmail: z.string().email().max(255).optional().or(z.literal('')),
  berufstraegerIds: z.array(z.string().uuid()).min(1, 'Mindestens ein Berufsträger ist Pflicht.'),
  hauptbearbeiterIds: z.array(z.string().uuid()),
});

export async function createOnboardingClientAction(formData: FormData) {
  const g = await staffActionGuard();
  if (!g.ok) redirect('/staff/login'); // redirect wirft (never) — bleibt außerhalb try/catch
  const { tenantId, staffId, ctx, session } = g;
  if (!isStaffAdmin(session)) {
    throw new ActionError('Nur ADMIN/PARTNER darf neue Mandanten anlegen.');
  }

  const parsed = Schema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    datevNo: formData.get('datevNo') ?? '',
    addisonNo: formData.get('addisonNo') ?? '',
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

  let clientId: string;
  try {
    clientId = await withTenantContext(ctx, async (tx) => {
      const assignedStaffIds = Array.from(
        new Set([...parsed.data.berufstraegerIds, ...parsed.data.hauptbearbeiterIds]),
      );
      const activeStaffCount = await tx.staffUser.count({
        where: { tenantId, id: { in: assignedStaffIds }, active: true },
      });
      if (activeStaffCount !== assignedStaffIds.length) {
        throw new ActionError('Eine gewählte Zuständigkeit ist nicht mehr aktiv.');
      }

      const client = await tx.client.create({
        data: {
          tenantId,
          name: parsed.data.name,
          kind: parsed.data.kind,
          datevNo: parsed.data.datevNo || null,
          addisonNo: parsed.data.addisonNo || null,
          allowActive: false,
          street: parsed.data.street || null,
          postalCode: parsed.data.postalCode || null,
          city: parsed.data.city || null,
          countryIso: parsed.data.countryIso || null,
          vatId: parsed.data.vatId || null,
          invoiceEmail: parsed.data.invoiceEmail || null,
        },
      });

      for (const sid of parsed.data.berufstraegerIds) {
        await tx.clientResponsibility.create({
          data: { tenantId, clientId: client.id, staffId: sid, role: 'BERUFSTRAEGER' },
        });
      }
      for (const sid of parsed.data.hauptbearbeiterIds) {
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
          name: parsed.data.name,
          kind: parsed.data.kind,
          onboarding: true,
          berufstraegerIds: parsed.data.berufstraegerIds,
          hauptbearbeiterIds: parsed.data.hauptbearbeiterIds,
        },
      });
      return client.id;
    });
  } catch (e) {
    if (e instanceof ActionError) redirectWithError(e.message);
    throw e;
  }

  redirect(`/staff/clients/onboarding/${clientId}?step=contact`);
}
