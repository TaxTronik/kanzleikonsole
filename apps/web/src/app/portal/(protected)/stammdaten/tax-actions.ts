'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { portalActionGuard, ActionError, type ActionResult } from '@/server/actions/portal-action';
import { toActionError } from '@/server/auth/rbac';
import { assertPortalFeature } from '@/server/settings/portal-features';
import { TaxMasterDataSchema } from '@/server/tax-master-data/schema';
import { loadTaxMasterDataTx } from '@/server/tax-master-data/service';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import type { TaxMasterSaveInput } from '@/components/tax-master-data-form';

export async function submitTaxChangeAction(input: TaxMasterSaveInput): Promise<ActionResult> {
  const g = await portalActionGuard();
  if (!g.ok) return g;
  const parsed = z
    .object({
      clientId: z.string().uuid(),
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
      draft: TaxMasterDataSchema,
      note: z.string().max(500).optional(),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ungültige Steuerdaten.' };
  if (parsed.data.clientId !== g.clientId) return { ok: false, error: 'Kein Zugriff.' };
  try {
    await assertPortalFeature(g.ctx, 'stammdatenSelfService');
    await withTenantContext(g.ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM client WHERE id = ${g.clientId}::uuid AND tenant_id = ${g.tenantId}::uuid FOR UPDATE`;
      if (
        await tx.clientMasterChangeRequest.findFirst({
          where: { clientId: g.clientId, status: 'PENDING' },
        })
      )
        throw new ActionError('Es gibt bereits eine offene Änderungsanfrage.');
      const current = await loadTaxMasterDataTx(tx, g.tenantId, g.clientId);
      if (current.anonymized)
        throw new ActionError(
          'Für anonymisierte Mandanten können keine Steuerdaten vorgeschlagen werden.',
        );
      if (current.revision !== parsed.data.expectedRevision)
        throw new ActionError('Die Steuerdaten wurden inzwischen geändert. Bitte Seite neu laden.');
      const knownIds = new Set(current.draft.registrations.map((row) => row.id));
      if (parsed.data.draft.registrations.some((row) => row.id && !knownIds.has(row.id)))
        throw new ActionError('Unbekannte Steuerverbindung.');
      const request = await tx.clientMasterChangeRequest.create({
        data: {
          tenantId: g.tenantId,
          clientId: g.clientId,
          contactId: g.contactId,
          fields: {
            taxData: { version: 1, expectedRevision: current.revision, draft: parsed.data.draft },
          },
          note: parsed.data.note?.trim() || null,
          status: 'PENDING',
        },
      });
      await evidenceService.record(tx, {
        tenantId: g.tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: g.contactId,
        action: 'client_master_change.submit',
        resourceType: 'client_master_change_request',
        resourceId: request.id,
        after: {
          clientId: g.clientId,
          fieldGroup: 'taxData',
          registrationCount: parsed.data.draft.registrations.length,
        },
      });
      const assignments = await tx.clientResponsibility.findMany({
        where: { clientId: g.clientId },
        select: { staffId: true },
      });
      const targets: Array<string | null> = assignments.length
        ? [...new Set(assignments.map((row) => row.staffId))]
        : [null];
      for (const staffId of targets)
        await notify(tx, {
          tenantId: g.tenantId,
          staffId,
          kind: 'CLIENT_MASTER_CHANGE_REQUEST',
          title: 'Steuerdatenänderung zur Prüfung',
          body: 'Der Mandant hat eine Änderung seiner steuerlichen Stammdaten vorgeschlagen.',
          href: `/staff/clients/${g.clientId}/change-requests`,
          resourceType: 'client_master_change_request',
          resourceId: request.id,
        });
    });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath('/portal/stammdaten');
  revalidatePath(`/staff/clients/${g.clientId}/change-requests`);
  return { ok: true };
}
