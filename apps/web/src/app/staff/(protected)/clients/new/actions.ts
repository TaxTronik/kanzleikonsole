'use server';

import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { z } from 'zod';

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
});

export async function createClientAction(formData: FormData) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  // Mandanten-Anlage berührt Stammdaten + GwG-Schranke (allow_active) — nur ADMIN/PARTNER.
  if (!isStaffAdmin(session)) {
    throw new Error('Nur ADMIN/PARTNER darf neue Mandanten anlegen.');
  }

  const { tenantId, staffId } = session.user;

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
  });

  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => i.message).join(', '));
  }

  const { name, kind, datevNo, street, postalCode, city, countryIso, vatId, invoiceEmail } = parsed.data;

  const clientId = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
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

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'client.created',
        resourceType: 'client',
        resourceId: client.id,
        after: { name, kind, datevNo: datevNo ?? null, hasAddress: !!(street && city) },
      });

      return client.id;
    },
  );

  redirect(`/staff/clients/${clientId}`);
}
