'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertClientInTenant, assertStaffInTenant } from '@/server/db/assert-tenant';

export interface ActionResult { ok: boolean; error?: string; }

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum YYYY-MM-DD'),
  subject: z.string().min(1).max(200),
  notes: z.string().max(2000).optional().or(z.literal('')),
  assigneeStaffId: z.string().uuid().nullable().optional(),
});

export async function createReminderAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = CreateSchema.safeParse({
    clientId: formData.get('clientId'),
    dueDate: formData.get('dueDate'),
    subject: formData.get('subject'),
    notes: formData.get('notes') ?? '',
    assigneeStaffId: formData.get('assigneeStaffId') || null,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // R-2: Tenant-Sanity für clientId und assigneeStaffId
        await assertClientInTenant(tx, parsed.data.clientId);
        if (parsed.data.assigneeStaffId) {
          await assertStaffInTenant(tx, parsed.data.assigneeStaffId);
        }
        const r = await tx.clientReminder.create({
          data: {
            tenantId,
            clientId: parsed.data.clientId,
            dueDate: new Date(parsed.data.dueDate),
            subject: parsed.data.subject.trim(),
            notes: parsed.data.notes?.trim() || null,
            createdByStaff: staffId,
            assigneeStaffId: parsed.data.assigneeStaffId ?? staffId,
          },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'client_reminder.create',
          resourceType: 'client_reminder',
          resourceId: r.id,
          after: {
            clientId: parsed.data.clientId,
            dueDate: parsed.data.dueDate,
            subject: parsed.data.subject,
          },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/staff/clients/${parsed.data.clientId}`);
  revalidatePath('/staff/dashboard');
  return { ok: true };
}

export async function markReminderDoneAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        await tx.clientReminder.update({
          where: { id: parsed.data.id },
          data: { doneAt: new Date(), doneByStaff: staffId },
        });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'client_reminder.done',
          resourceType: 'client_reminder',
          resourceId: parsed.data.id,
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/clients', 'layout');
  revalidatePath('/staff/dashboard');
  return { ok: true };
}

export async function deleteReminderAction(input: { id: string }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const r = await tx.clientReminder.findUnique({ where: { id: parsed.data.id }, select: { subject: true } });
        await tx.clientReminder.delete({ where: { id: parsed.data.id } });
        await evidenceService.record(tx, {
          tenantId, actorType: 'STAFF', actorId: staffId,
          action: 'client_reminder.delete',
          resourceType: 'client_reminder',
          resourceId: parsed.data.id,
          before: { subject: r?.subject ?? null },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/clients', 'layout');
  revalidatePath('/staff/dashboard');
  return { ok: true };
}
