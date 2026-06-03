'use server';

import { z } from 'zod';
import { evidenceService } from '@/server/container';
import { withStaff, type ActionResult } from '@/server/actions/staff-action';

export type { ActionResult };

const Schema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  hasDataAccess: z.enum(['1', 'on', 'true']).optional(),
  contactEmail: z.string().email().max(255).optional().or(z.literal('')),
  contractFromDate: z.string().date().optional().or(z.literal('')),
  contractToDate: z.string().date().optional().or(z.literal('')),
  notes: z.string().max(5000).optional().or(z.literal('')),
});

export async function createServiceProviderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = Schema.safeParse({
    name: formData.get('name'),
    category: formData.get('category'),
    hasDataAccess: formData.get('hasDataAccess') ?? undefined,
    contactEmail: formData.get('contactEmail') ?? '',
    contractFromDate: formData.get('contractFromDate') ?? '',
    contractToDate: formData.get('contractToDate') ?? '',
    notes: formData.get('notes') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const data = parsed.data;

  // Dienstleister-Verzeichnis ist DSGVO/AVV-Compliance — nur ADMIN/PARTNER.
  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const provider = await tx.serviceProvider.create({
        data: {
          tenantId,
          name: data.name,
          category: data.category,
          hasDataAccess: !!data.hasDataAccess,
          contactEmail: data.contactEmail || null,
          contractFromDate: data.contractFromDate ? new Date(data.contractFromDate) : null,
          contractToDate: data.contractToDate ? new Date(data.contractToDate) : null,
          notes: data.notes || null,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'service_provider.create',
        resourceType: 'service_provider',
        resourceId: provider.id,
        after: { name: data.name, category: data.category, hasDataAccess: !!data.hasDataAccess },
      });
    },
    { requireAdmin: true, revalidate: '/staff/service-providers' },
  );
}

export async function deleteServiceProviderAction(formData: FormData): Promise<void> {
  // F6: UUID-Validation.
  const parsed = z.object({ id: z.string().uuid() }).safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  const { id } = parsed.data;

  // Löschen ist ebenfalls DSGVO/AVV-relevant → nur ADMIN/PARTNER.
  await withStaff(
    async (tx, { tenantId, staffId }) => {
      const before = await tx.serviceProvider.findUnique({ where: { id } });
      if (!before) return;
      await tx.serviceProvider.delete({ where: { id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'service_provider.delete',
        resourceType: 'service_provider',
        resourceId: id,
        before: { name: before.name, category: before.category },
      });
    },
    { requireAdmin: true, revalidate: '/staff/service-providers' },
  );
}
