'use server';

import { withTenantContext } from '@taxtronik/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import {
  staffActionGuard,
  withStaffModule,
  type ActionResult,
} from '@/server/actions/staff-action';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
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

const withBwaStaff = withStaffModule('bwa');

function validClientId(clientId: string): boolean {
  return z.string().uuid().safeParse(clientId).success;
}

// clientId is bound by the page as the first server-action argument.
export async function createStaffPlanAction(
  clientId: string,
  input: CreateBwaPlanInput,
): Promise<ActionResult> {
  const guard = await staffActionGuard({ module: 'bwa' });
  if (!guard.ok) return guard;
  const { tenantId, staffId, ctx, session } = guard;
  if (!validClientId(clientId)) return { ok: false, error: 'Mandant ungültig.' };
  const parsed = CreateBwaPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  let planId: string;
  try {
    planId = await withTenantContext(ctx, async (tx) => {
      await assertClientAccessTx(tx, session, clientId);
      return createBwaPlanTx(tx, {
        tenantId,
        clientId,
        actor: { id: staffId, type: 'STAFF' },
        data: parsed.data,
      });
    });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`/staff/clients/${clientId}/bwa/plans`);
  redirect(`/staff/clients/${clientId}/bwa/plans/${planId}`);
}

export async function updateStaffPlanAction(
  clientId: string,
  input: UpdateBwaPlanInput,
): Promise<ActionResult> {
  if (!validClientId(clientId)) return { ok: false, error: 'Mandant ungültig.' };
  const parsed = UpdateBwaPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withBwaStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, clientId);
      await updateBwaPlanTx(tx, {
        tenantId,
        clientId,
        actor: { id: staffId, type: 'STAFF' },
        data: parsed.data,
      });
    },
    {
      revalidate: [
        `/staff/clients/${clientId}/bwa/plans/${parsed.data.planId}`,
        `/staff/clients/${clientId}/bwa/plans`,
        `/staff/clients/${clientId}/bwa`,
        '/portal/bwa',
      ],
    },
  );
}

export async function deleteStaffPlanAction(
  clientId: string,
  input: { planId: string },
): Promise<ActionResult> {
  if (!validClientId(clientId)) return { ok: false, error: 'Mandant ungültig.' };
  const parsed = DeleteBwaPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withBwaStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, clientId);
      await deleteBwaPlanTx(tx, {
        tenantId,
        clientId,
        planId: parsed.data.planId,
        actor: { id: staffId, type: 'STAFF' },
      });
    },
    { revalidate: [`/staff/clients/${clientId}/bwa/plans`, `/staff/clients/${clientId}/bwa`] },
  );
}
