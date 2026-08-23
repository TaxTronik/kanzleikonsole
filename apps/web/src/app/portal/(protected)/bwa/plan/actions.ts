'use server';

import { withTenantContext } from '@taxtronik/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  portalActionGuard,
  withPortalModule,
  type ActionResult,
} from '@/server/actions/portal-action';

const withBwaPortal = withPortalModule('bwa');
import { toActionError } from '@/server/auth/rbac';
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
  const guard = await portalActionGuard({ module: 'bwa' });
  if (!guard.ok) return guard;
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
  try {
    await assertPortalFeature(ctx, 'bwaPlanning');
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  let planId: string;
  try {
    planId = await withTenantContext(ctx, (tx) =>
      createBwaPlanTx(tx, {
        tenantId,
        clientId,
        actor: { id: contactId, type: 'CLIENT_CONTACT' },
        data: parsed.data,
      }),
    );
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath('/portal/bwa');
  redirect(`/portal/bwa/plan/${planId}`);
}

export async function updatePlanAction(input: UpdateBwaPlanInput): Promise<ActionResult> {
  const guard = await portalActionGuard({ module: 'bwa' });
  if (!guard.ok) return guard;
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

  try {
    await withTenantContext(ctx, (tx) =>
      updateBwaPlanTx(tx, {
        tenantId,
        clientId,
        actor: { id: contactId, type: 'CLIENT_CONTACT' },
        data: parsed.data,
      }),
    );
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/portal/bwa/plan/${parsed.data.planId}`);
  revalidatePath('/portal/bwa');
  return { ok: true };
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
