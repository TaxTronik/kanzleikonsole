'use server';

import { withTenantContext } from '@taxtronik/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { portalAction, withPortalModule, type ActionResult } from '@/server/actions/portal-action';

const withBwaPortal = withPortalModule('bwa');
import {
  CreateBwaPlanSchema,
  DeleteBwaPlanSchema,
  UpdateBwaPlanSchema,
  createBwaPlanTx,
  deleteBwaPlanTx,
  updateBwaPlanTx,
  type CreateBwaPlanInput,
  type UpdateBwaPlanInput,
} from '@/server/bwa/plans';
import { checkPortalWriteLimit } from '@/server/rate-limit';
import { assertPortalFeature } from '@/server/settings/portal-features';

export async function createPlanAction(input: CreateBwaPlanInput): Promise<ActionResult> {
  const result = await portalAction({
    guard: { module: 'bwa' },
    run: async (guard) => {
      const { tenantId, contactId, clientId, ctx } = guard;

      const rateLimit = await checkPortalWriteLimit(contactId);
      if (!rateLimit.ok) {
        return {
          ok: false,
          error: `Zu viele Aktionen. Bitte ${Math.ceil(rateLimit.retryAfter / 60)} Min. warten.`,
        };
      }
      const parsed = CreateBwaPlanSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
      await assertPortalFeature(ctx, 'bwaPlanning');

      const planId = await withTenantContext(ctx, (tx) =>
        createBwaPlanTx(tx, {
          tenantId,
          clientId,
          actor: { id: contactId, type: 'CLIENT_CONTACT' },
          data: parsed.data,
        }),
      );
      return { planId };
    },
    revalidate: '/portal/bwa',
  });
  if (!result.ok) return result;
  redirect(`/portal/bwa/plan/${result.planId}`);
}

export async function updatePlanAction(input: UpdateBwaPlanInput): Promise<ActionResult> {
  return portalAction({
    guard: { module: 'bwa' },
    run: async (guard) => {
      const { tenantId, contactId, clientId, ctx } = guard;

      const rateLimit = await checkPortalWriteLimit(contactId);
      if (!rateLimit.ok) {
        return {
          ok: false,
          error: `Zu viele Aktionen. Bitte ${Math.ceil(rateLimit.retryAfter / 60)} Min. warten.`,
        };
      }
      const parsed = UpdateBwaPlanSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

      await withTenantContext(ctx, (tx) =>
        updateBwaPlanTx(tx, {
          tenantId,
          clientId,
          actor: { id: contactId, type: 'CLIENT_CONTACT' },
          data: parsed.data,
        }),
      );
      revalidatePath(`/portal/bwa/plan/${parsed.data.planId}`);
    },
    revalidate: '/portal/bwa',
  });
}

export async function deletePlanAction(input: { planId: string }): Promise<ActionResult> {
  const parsed = DeleteBwaPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withBwaPortal(
    (tx, { tenantId, contactId, clientId }) =>
      deleteBwaPlanTx(tx, {
        tenantId,
        clientId,
        planId: parsed.data.planId,
        actor: { id: contactId, type: 'CLIENT_CONTACT' },
      }),
    { revalidate: '/portal/bwa' },
  );
}
