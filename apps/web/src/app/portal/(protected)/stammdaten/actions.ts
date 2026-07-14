'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { assertPortalFeature } from '@/server/settings/portal-features';
import { toActionError } from '@/server/auth/rbac';
import { portalActionGuard, ActionError, type ActionResult } from '@/server/actions/portal-action';

const FieldsSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    street: z.string().max(255).optional(),
    postalCode: z.string().max(20).optional(),
    city: z.string().max(100).optional(),
    countryIso: z.string().length(2).optional().or(z.literal('')),
    vatId: z.string().max(20).optional(),
    invoiceEmail: z.string().email().max(255).optional().or(z.literal('')),
  })
  .strict();

const InputSchema = z.object({
  clientId: z.string().uuid(),
  fields: FieldsSchema,
  note: z.string().max(500).nullable().optional(),
});

export async function submitMasterChangeAction(
  input: z.infer<typeof InputSchema>,
): Promise<ActionResult> {
  const g = await portalActionGuard();
  if (!g.ok) return g;
  const { tenantId, contactId, clientId, ctx } = g;

  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (parsed.data.clientId !== clientId) return { ok: false, error: 'Kein Zugriff.' };

  // F2: Feature-Flag-Guard. UI-Redirect ist nicht ausreichend — direkter
  // Action-Call (z. B. via serialisiertem Form-Submit) muss ebenfalls geblockt
  // werden, wenn das Feature im Portal deaktiviert wurde.
  try {
    await assertPortalFeature(ctx, 'stammdatenSelfService');
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const fieldEntries = Object.entries(parsed.data.fields).filter(
    ([, v]) => v !== undefined && v !== null,
  );
  if (fieldEntries.length === 0) {
    return { ok: false, error: 'Keine Änderungen.' };
  }
  const fields = Object.fromEntries(fieldEntries) as Record<string, string>;

  try {
    await withTenantContext(ctx, async (tx) => {
      const existing = await tx.clientMasterChangeRequest.findFirst({
        where: { clientId, status: 'PENDING' },
      });
      if (existing) throw new ActionError('Es gibt bereits eine offene Änderungsanfrage.');

      const req = await tx.clientMasterChangeRequest.create({
        data: {
          tenantId,
          clientId,
          contactId,
          fields: fields as Prisma.InputJsonValue,
          note: parsed.data.note ?? null,
          status: 'PENDING',
        },
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'CLIENT_CONTACT',
        actorId: contactId,
        action: 'client_master_change.submit',
        resourceType: 'client_master_change_request',
        resourceId: req.id,
        after: { fields, note: parsed.data.note ?? null },
      });

      // Alle für diesen Mandanten zuständigen Mitarbeiter benachrichtigen
      const responsibilities = await tx.clientResponsibility.findMany({
        where: { clientId },
        select: { staffId: true },
      });
      const staffIds = Array.from(new Set(responsibilities.map((r) => r.staffId)));
      const targets: Array<string | null> = staffIds.length === 0 ? [null] : staffIds;
      for (const staffId of targets) {
        await notify(tx, {
          tenantId,
          staffId,
          kind: 'CLIENT_MASTER_CHANGE_REQUEST',
          title: 'Mandant schlägt Stammdaten-Änderung vor',
          body: Object.keys(fields).join(', '),
          href: `/staff/clients/${clientId}/change-requests`,
          resourceType: 'client_master_change_request',
          resourceId: req.id,
        });
      }
    });
  } catch (e) {
    return toActionError(e);
  }

  revalidatePath('/portal/stammdaten');
  return { ok: true };
}
