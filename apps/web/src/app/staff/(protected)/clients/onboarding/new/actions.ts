'use server';

import { areProfessionalAssigneesEligibleTx } from '@/server/gwg/professional-review';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { toActionError } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { staffActionGuard, ActionError, type ActionResult } from '@/server/actions/staff-action';
import { validationFailure } from '@/server/actions/form-data';

const Schema = z.object({
  name: z.string().min(1, 'Name ist Pflichtfeld').max(200),
  kind: z.enum(['NATPERS', 'JURPERS', 'PERSGES']),
  datevNo: z.string().max(40).optional().or(z.literal('')),
  addisonNo: z.string().max(40).optional().or(z.literal('')),
  street: z.string().max(200).optional().or(z.literal('')),
  postalCode: z.string().max(20).optional().or(z.literal('')),
  city: z.string().max(100).optional().or(z.literal('')),
  countryIso: z.string().length(2).optional().or(z.literal('')),
  invoiceEmail: z.string().email().max(255).optional().or(z.literal('')),
  berufstraegerIds: z.array(z.string().uuid()).min(1, 'Mindestens ein Berufsträger ist Pflicht.'),
  hauptbearbeiterIds: z.array(z.string().uuid()),
});

export async function createOnboardingClientAction(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  // ACCESS-STAFF-PERMISSION-001: wie die Schnellanlage nur über das Einzelrecht
  // CLIENT_CREATE (ADMIN/PARTNER implizit); der Onboarding-Mandant startet mit
  // allowActive=false.
  const g = await staffActionGuard({ requirePermission: 'CLIENT_CREATE' });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = Schema.safeParse({
    name: formData.get('name'),
    kind: formData.get('kind'),
    datevNo: formData.get('datevNo') ?? '',
    addisonNo: formData.get('addisonNo') ?? '',
    street: formData.get('street') ?? '',
    postalCode: formData.get('postalCode') ?? '',
    city: formData.get('city') ?? '',
    countryIso: ((formData.get('countryIso') as string) ?? '').toUpperCase(),
    invoiceEmail: formData.get('invoiceEmail') ?? '',
    berufstraegerIds: formData.getAll('berufstraegerIds').map(String),
    hauptbearbeiterIds: formData.getAll('hauptbearbeiterIds').map(String),
  });
  if (!parsed.success) {
    return validationFailure(
      parsed.error.issues,
      parsed.error.issues.map((i) => i.message).join(', '),
    );
  }
  const berufstraegerIds = Array.from(new Set(parsed.data.berufstraegerIds));
  const hauptbearbeiterIds = Array.from(new Set(parsed.data.hauptbearbeiterIds));

  let clientId: string;
  try {
    clientId = await withTenantContext(ctx, async (tx) => {
      const assignedStaffIds = Array.from(new Set([...berufstraegerIds, ...hauptbearbeiterIds]));
      const activeStaffCount = await tx.staffUser.count({
        where: {
          tenantId,
          id: { in: assignedStaffIds },
          active: true,
          roles: { some: {} },
        },
      });
      if (activeStaffCount !== assignedStaffIds.length) {
        throw new ActionError(
          'Eine gewählte Zuständigkeit ist nicht mehr aktiv oder hat keine gültige Staff-Rolle.',
        );
      }
      if (!(await areProfessionalAssigneesEligibleTx(tx, tenantId, berufstraegerIds))) {
        throw new ActionError(
          'Als Berufsträger sind nur aktive, als Berufsträger qualifizierte Mitarbeiter zulässig.',
        );
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
          invoiceEmail: parsed.data.invoiceEmail || null,
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
          name: parsed.data.name,
          kind: parsed.data.kind,
          onboarding: true,
          berufstraegerIds,
          hauptbearbeiterIds,
        },
      });
      return client.id;
    });
  } catch (e) {
    return toActionError(e);
  }

  redirect(`/staff/clients/onboarding/${clientId}?step=contact`);
}
