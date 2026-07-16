import type { TxClient } from '@taxtronik/db';
import { z } from 'zod';

import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';

export const BWA_PLAN_AXES = [
  'REVENUE',
  'PERSONNEL',
  'OTHER_COSTS',
  'DEPRECIATION',
  'MATERIAL',
  'OTHER_INCOME',
  'TAXES',
] as const;

export const CreateBwaPlanSchema = z.object({
  name: z.string().min(1).max(120),
  year: z.number().int().min(2020).max(2099),
  basePeriodId: z.string().uuid().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(['DRAFT', 'FINAL']).default('FINAL'),
  lines: z
    .array(
      z.object({
        axis: z.enum(BWA_PLAN_AXES),
        amount: z.number(),
        note: z.string().max(300).nullable().optional(),
      }),
    )
    .max(20),
});

export const UpdateBwaPlanSchema = z.object({
  planId: z.string().uuid(),
  name: z.string().min(1).max(120),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(['DRAFT', 'FINAL']),
  lines: z
    .array(
      z.object({
        axis: z.enum(BWA_PLAN_AXES),
        amount: z.number(),
        note: z.string().max(300).nullable().optional(),
      }),
    )
    .max(20),
});

export const DeleteBwaPlanSchema = z.object({ planId: z.string().uuid() });

export type CreateBwaPlanInput = z.infer<typeof CreateBwaPlanSchema>;
export type UpdateBwaPlanInput = z.infer<typeof UpdateBwaPlanSchema>;

type BwaPlanLineInput = CreateBwaPlanInput['lines'][number];
type BwaPlanActorType = 'STAFF' | 'CLIENT_CONTACT';

interface BwaPlanActor {
  id: string;
  type: BwaPlanActorType;
}

export function uniqueBwaPlanLines(lines: BwaPlanLineInput[]): BwaPlanLineInput[] {
  const seen = new Set<string>();
  return lines.filter(({ axis }) => {
    if (seen.has(axis)) return false;
    seen.add(axis);
    return true;
  });
}

export async function assertBwaBasePeriodForClientTx(
  tx: TxClient,
  clientId: string,
  basePeriodId: string | null | undefined,
): Promise<void> {
  if (!basePeriodId) return;
  const period = await tx.bwaPeriod.findFirst({
    where: { id: basePeriodId, clientId },
    select: { id: true },
  });
  if (!period) throw new ActionError('BWA-Periode nicht gefunden.');
}

export async function createBwaPlanTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    actor: BwaPlanActor;
    data: CreateBwaPlanInput;
  },
): Promise<string> {
  const { tenantId, clientId, actor, data } = input;
  await assertBwaBasePeriodForClientTx(tx, clientId, data.basePeriodId);
  const lines = uniqueBwaPlanLines(data.lines);
  const plan = await tx.bwaPlan.create({
    data: {
      tenantId,
      clientId,
      name: data.name,
      year: data.year,
      basePeriodId: data.basePeriodId ?? null,
      notes: data.notes ?? null,
      status: data.status,
      createdBy: actor.id,
      createdByType: actor.type,
      updatedBy: actor.id,
      updatedByType: actor.type,
      lines: {
        create: lines.map((line) => ({
          axis: line.axis,
          amount: line.amount,
          note: line.note ?? null,
        })),
      },
    },
  });
  await evidenceService.record(tx, {
    tenantId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'bwa_plan.create',
    resourceType: 'bwa_plan',
    resourceId: plan.id,
    after: {
      name: data.name,
      year: data.year,
      lineCount: lines.length,
      createdByType: actor.type,
    },
  });
  return plan.id;
}

export async function updateBwaPlanTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    actor: BwaPlanActor;
    data: UpdateBwaPlanInput;
  },
): Promise<void> {
  const { tenantId, clientId, actor, data } = input;
  const plan = await tx.bwaPlan.findUnique({
    where: { id: data.planId },
    select: { id: true, clientId: true },
  });
  if (!plan) throw new ActionError('Plan nicht gefunden.');
  if (plan.clientId !== clientId) throw new ActionError('Kein Zugriff.');

  const lines = uniqueBwaPlanLines(data.lines);
  await tx.bwaPlan.update({
    where: { id: data.planId },
    data: {
      name: data.name,
      notes: data.notes ?? null,
      status: data.status,
      updatedBy: actor.id,
      updatedByType: actor.type,
    },
  });
  await tx.bwaPlanLine.deleteMany({ where: { planId: data.planId } });
  if (lines.length > 0) {
    await tx.bwaPlanLine.createMany({
      data: lines.map((line) => ({
        planId: data.planId,
        axis: line.axis,
        amount: line.amount,
        note: line.note ?? null,
      })),
    });
  }
  await evidenceService.record(tx, {
    tenantId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'bwa_plan.update',
    resourceType: 'bwa_plan',
    resourceId: data.planId,
    after: {
      name: data.name,
      status: data.status,
      lineCount: lines.length,
      updatedByType: actor.type,
    },
  });
}

export async function deleteBwaPlanTx(
  tx: TxClient,
  input: {
    tenantId: string;
    clientId: string;
    planId: string;
    actor: BwaPlanActor;
  },
): Promise<void> {
  const { tenantId, clientId, planId, actor } = input;
  const plan = await tx.bwaPlan.findUnique({
    where: { id: planId },
    select: { id: true, clientId: true, name: true, year: true },
  });
  if (!plan) throw new ActionError('Plan nicht gefunden.');
  if (plan.clientId !== clientId) throw new ActionError('Kein Zugriff.');

  await tx.bwaPlan.delete({ where: { id: planId } });
  await evidenceService.record(tx, {
    tenantId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'bwa_plan.delete',
    resourceType: 'bwa_plan',
    resourceId: planId,
    before: { name: plan.name, year: plan.year },
  });
}
