'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertClientInTenant } from '@/server/db/assert-tenant';

const StartSchema = z.object({
  description: z.string().min(1).max(500),
  clientId: z.string().uuid().optional().or(z.literal('')),
  billable: z.enum(['1', 'on', 'true']).optional(),
});

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function startTimerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };

  const parsed = StartSchema.safeParse({
    description: formData.get('description'),
    clientId: formData.get('clientId') ?? '',
    billable: formData.get('billable') ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      // R-2: clientId Tenant-Sanity falls gesetzt
      if (parsed.data.clientId) {
        await assertClientInTenant(tx, parsed.data.clientId);
      }
      // Wenn ein Timer läuft → erst stoppen
      await tx.timeEntry.updateMany({
        where: { staffId, endedAt: null },
        data: { endedAt: new Date() },
      });

      const entry = await tx.timeEntry.create({
        data: {
          tenantId,
          staffId,
          clientId: parsed.data.clientId || null,
          description: parsed.data.description,
          startedAt: new Date(),
          billable: !!parsed.data.billable,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'time_entry.start',
        resourceType: 'time_entry',
        resourceId: entry.id,
        after: { description: parsed.data.description, clientId: parsed.data.clientId || null },
      });
    },
  );

  revalidatePath('/staff/time');
  return { ok: true };
}

export async function stopTimerAction(): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;
  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const running = await tx.timeEntry.findFirst({
        where: { staffId, endedAt: null },
      });
      if (!running) return;
      const updated = await tx.timeEntry.update({
        where: { id: running.id },
        data: { endedAt: new Date() },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'time_entry.stop',
        resourceType: 'time_entry',
        resourceId: updated.id,
        after: { startedAt: updated.startedAt.toISOString(), endedAt: updated.endedAt?.toISOString() ?? null },
      });
    },
  );

  revalidatePath('/staff/time');
}

export async function deleteTimeEntryAction(formData: FormData): Promise<void> {
  const session = await staffAuth();
  if (!session?.user) return;
  // F6: UUID-Validation.
  const parsed = z.object({ id: z.string().uuid() }).safeParse({ id: formData.get('id') });
  if (!parsed.success) return;
  const { id } = parsed.data;

  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const before = await tx.timeEntry.findFirst({ where: { id, staffId } });
      if (!before) return;
      await tx.timeEntry.delete({ where: { id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'time_entry.delete',
        resourceType: 'time_entry',
        resourceId: id,
        before: { description: before.description },
      });
    },
  );

  revalidatePath('/staff/time');
}
