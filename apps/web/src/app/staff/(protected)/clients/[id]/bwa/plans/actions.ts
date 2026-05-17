'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const AXES = [
  'REVENUE', 'PERSONNEL', 'OTHER_COSTS', 'DEPRECIATION', 'MATERIAL', 'OTHER_INCOME', 'TAXES',
] as const;
type Axis = (typeof AXES)[number];

const CreateSchema = z.object({
  name: z.string().min(1).max(120),
  year: z.number().int().min(2020).max(2099),
  basePeriodId: z.string().uuid().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(['DRAFT', 'FINAL']).default('FINAL'),
  lines: z.array(
    z.object({
      axis: z.enum(AXES),
      amount: z.number(),
      note: z.string().max(300).nullable().optional(),
    }),
  ).max(20),
});

// clientId wird per `.bind(null, clientId)` aus der Page als erstes Argument
// fest gebunden — so kann die Action serialisiert vom Server zur Client-
// Component gereicht werden (Next.js-Pattern für Server-Actions mit Params).
export async function createStaffPlanAction(
  clientId: string,
  input: z.infer<typeof CreateSchema>,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!z.string().uuid().safeParse(clientId).success) return { ok: false, error: 'Mandant ungültig.' };
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  const seen = new Set<Axis>();
  const lines = parsed.data.lines.filter((l) => {
    if (seen.has(l.axis)) return false;
    seen.add(l.axis);
    return true;
  });

  let id: string;
  try {
    id = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const plan = await tx.bwaPlan.create({
          data: {
            tenantId,
            clientId,
            name: parsed.data.name,
            year: parsed.data.year,
            basePeriodId: parsed.data.basePeriodId ?? null,
            notes: parsed.data.notes ?? null,
            status: parsed.data.status,
            createdBy: staffId,
            createdByType: 'STAFF',
            updatedBy: staffId,
            updatedByType: 'STAFF',
            lines: {
              create: lines.map((l) => ({
                axis: l.axis,
                amount: l.amount,
                note: l.note ?? null,
              })),
            },
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'bwa_plan.create',
          resourceType: 'bwa_plan',
          resourceId: plan.id,
          after: { name: parsed.data.name, year: parsed.data.year, lineCount: lines.length, createdByType: 'STAFF' },
        });
        return plan.id;
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/staff/clients/${clientId}/bwa/plans`);
  redirect(`/staff/clients/${clientId}/bwa/plans/${id}`);
}

const UpdateSchema = z.object({
  planId: z.string().uuid(),
  name: z.string().min(1).max(120),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(['DRAFT', 'FINAL']),
  lines: z.array(
    z.object({
      axis: z.enum(AXES),
      amount: z.number(),
      note: z.string().max(300).nullable().optional(),
    }),
  ).max(20),
});

export async function updateStaffPlanAction(
  clientId: string,
  input: z.infer<typeof UpdateSchema>,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!z.string().uuid().safeParse(clientId).success) return { ok: false, error: 'Mandant ungültig.' };
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { planId } = parsed.data;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const plan = await tx.bwaPlan.findUnique({ where: { id: planId } });
        if (!plan) throw new Error('Plan nicht gefunden.');
        if (plan.clientId !== clientId) throw new Error('Kein Zugriff.');

        await tx.bwaPlan.update({
          where: { id: planId },
          data: {
            name: parsed.data.name,
            notes: parsed.data.notes ?? null,
            status: parsed.data.status,
            updatedBy: staffId,
            updatedByType: 'STAFF',
          },
        });
        await tx.bwaPlanLine.deleteMany({ where: { planId } });
        for (const l of parsed.data.lines) {
          await tx.bwaPlanLine.create({
            data: { planId, axis: l.axis, amount: l.amount, note: l.note ?? null },
          });
        }
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'bwa_plan.update',
          resourceType: 'bwa_plan',
          resourceId: planId,
          after: { name: parsed.data.name, status: parsed.data.status, lineCount: parsed.data.lines.length, updatedByType: 'STAFF' },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/staff/clients/${clientId}/bwa/plans/${planId}`);
  revalidatePath(`/staff/clients/${clientId}/bwa/plans`);
  revalidatePath(`/staff/clients/${clientId}/bwa`);
  revalidatePath('/portal/bwa');
  return { ok: true };
}

export async function deleteStaffPlanAction(
  clientId: string,
  input: { planId: string },
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!z.string().uuid().safeParse(clientId).success) return { ok: false, error: 'Mandant ungültig.' };
  const parsed = z.object({ planId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { planId } = parsed.data;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const plan = await tx.bwaPlan.findUnique({ where: { id: planId } });
        if (!plan) throw new Error('Plan nicht gefunden.');
        if (plan.clientId !== clientId) throw new Error('Kein Zugriff.');
        await tx.bwaPlan.delete({ where: { id: planId } });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'bwa_plan.delete',
          resourceType: 'bwa_plan',
          resourceId: planId,
          before: { name: plan.name, year: plan.year },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/staff/clients/${clientId}/bwa/plans`);
  revalidatePath(`/staff/clients/${clientId}/bwa`);
  return { ok: true };
}
