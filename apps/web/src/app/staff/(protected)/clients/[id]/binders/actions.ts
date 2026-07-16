'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

const StatusEnum = z.enum(['PREPARED', 'WITH_CLIENT', 'RETURNED', 'COMPLETED']);

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  label: z.string().min(1).max(200),
  contents: z.string().max(4000).optional().or(z.literal('')),
  expectedReturnAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal('')),
});

export async function createBinderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    label: formData.get('label'),
    contents: formData.get('contents') ?? '',
    expectedReturnAt: formData.get('expectedReturnAt') ?? '',
  });
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, parsed.data.clientId);
      // Q-5: clientId Tenant-Sanity
      await assertClientInTenant(tx, parsed.data.clientId);
      const b = await tx.pendingBinder.create({
        data: {
          tenantId,
          clientId: parsed.data.clientId,
          label: parsed.data.label.trim(),
          contents: parsed.data.contents?.trim() || null,
          expectedReturnAt: parsed.data.expectedReturnAt
            ? new Date(parsed.data.expectedReturnAt)
            : null,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'pending_binder.create',
        resourceType: 'pending_binder',
        resourceId: b.id,
        after: { clientId: parsed.data.clientId, label: parsed.data.label },
      });
    },
    { revalidate: `/staff/clients/${parsed.data.clientId}` },
  );
}

export async function updateBinderStatusAction(input: {
  id: string;
  status: 'PREPARED' | 'WITH_CLIENT' | 'RETURNED' | 'COMPLETED';
}): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid(), status: StatusEnum }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const before = await tx.pendingBinder.findUnique({
      where: { id: parsed.data.id },
      select: { status: true, clientId: true },
    });
    if (!before) throw new ActionError('Pendelordner nicht gefunden.');
    await assertClientAccessTx(tx, session, before.clientId);

    const now = new Date();
    const data: Prisma.PendingBinderUpdateInput = { status: parsed.data.status };
    if (parsed.data.status === 'WITH_CLIENT') data.sentAt = now;
    if (parsed.data.status === 'RETURNED') data.returnedAt = now;
    if (parsed.data.status === 'COMPLETED') data.completedAt = now;

    await tx.pendingBinder.update({ where: { id: parsed.data.id }, data });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'pending_binder.status_change',
      resourceType: 'pending_binder',
      resourceId: parsed.data.id,
      before: { status: before.status },
      after: { status: parsed.data.status },
    });
    return { clientId: before.clientId };
  });
  if (r.ok && r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
  return r;
}

export async function deleteBinderAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const b = await tx.pendingBinder.findUnique({
      where: { id: parsed.data.id },
      select: { label: true, clientId: true },
    });
    if (!b) throw new ActionError('Pendelordner nicht gefunden.');
    await assertClientAccessTx(tx, session, b.clientId);
    await tx.pendingBinder.delete({ where: { id: parsed.data.id } });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'pending_binder.delete',
      resourceType: 'pending_binder',
      resourceId: parsed.data.id,
      before: { label: b?.label ?? null },
    });
    return { clientId: b.clientId };
  });
  if (r.ok && r.clientId) revalidatePath(`/staff/clients/${r.clientId}`);
  return r;
}
