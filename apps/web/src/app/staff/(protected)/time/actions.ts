'use server';

import { z } from 'zod';
import { evidenceService } from '@/server/container';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import {
  withStaff,
  ActionError,
  parseFormData,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

export type ActionResult = BaseActionResult;

const StartSchema = z.object({
  description: z.string().min(1).max(500),
  clientId: z.string().uuid().optional().or(z.literal('')),
  billable: z.enum(['1', 'on', 'true']).optional(),
});

export async function startTimerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = StartSchema.safeParse({
    description: formData.get('description'),
    clientId: formData.get('clientId') ?? '',
    billable: formData.get('billable') ?? undefined,
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId, session }) => {
      // R-2: clientId Tenant-Sanity + Vertraulich-/RESTRICTED-Ventil, falls gesetzt
      if (parsed.data.clientId) {
        await assertClientInTenant(tx, parsed.data.clientId);
        await assertClientAccessTx(tx, session, parsed.data.clientId);
      }
      // Wenn ein Timer läuft → erst stoppen
      const running = await tx.timeEntry.findFirst({
        where: { staffId, endedAt: null },
        select: { clientId: true },
      });
      if (running?.clientId) await assertClientAccessTx(tx, session, running.clientId);
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
    { revalidate: '/staff/time' },
  );
}

export async function stopTimerAction(): Promise<void> {
  await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const running = await tx.timeEntry.findFirst({
        where: { staffId, endedAt: null },
      });
      if (!running) return;
      if (running.clientId) await assertClientAccessTx(tx, session, running.clientId);
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
        after: {
          startedAt: updated.startedAt.toISOString(),
          endedAt: updated.endedAt?.toISOString() ?? null,
        },
      });
    },
    { revalidate: '/staff/time' },
  );
}

export async function deleteTimeEntryAction(formData: FormData): Promise<void> {
  // F6: UUID-Validation.
  const parsed = parseFormData(z.object({ id: z.string().uuid() }), formData);
  if (!parsed.ok) return;
  const { id } = parsed.data;

  await withStaff(
    async (tx, { tenantId, staffId, session }) => {
      const before = await tx.timeEntry.findFirst({ where: { id, staffId } });
      if (!before) return;
      if (before.clientId) await assertClientAccessTx(tx, session, before.clientId);
      // iter85 (GoB, Befund 10): abgerechnete Stunden sind Abrechnungsgrundlage
      // einer Rechnung — Löschen würde den Beleg-Zusammenhang zerstören.
      if (before.invoiceId) {
        throw new ActionError(
          'Dieser Eintrag ist bereits abgerechnet und kann nicht gelöscht werden.',
        );
      }
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
    { revalidate: '/staff/time' },
  );
}
