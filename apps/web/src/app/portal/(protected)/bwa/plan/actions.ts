'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { assertPortalFeature } from '@/server/settings/portal-features';
import { checkPortalWriteLimit } from '@/server/rate-limit';

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

export async function createPlanAction(input: z.infer<typeof CreateSchema>): Promise<ActionResult> {
  const session = await portalAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  // S4: Portal-Schreib-Backstop.
  const rl = await checkPortalWriteLimit(session.user.contactId);
  if (!rl.ok) {
    return { ok: false, error: `Zu viele Aktionen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.` };
  }
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, contactId, clientId } = session.user;
  try {
    await assertPortalFeature(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      'bwaPlanning',
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  // Deduplication per axis
  const seen = new Set<Axis>();
  const lines = parsed.data.lines.filter((l) => {
    if (seen.has(l.axis)) return false;
    seen.add(l.axis);
    return true;
  });

  let id: string;
  try {
    id = await withTenantContext(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      async (tx) => {
        // M-1: basePeriodId-Sanity-Check. RLS filtert beim Lesen, FK greift
        // nur auf Existenz — Cross-Tenant-Verlinkung wäre sonst möglich.
        if (parsed.data.basePeriodId) {
          const p = await tx.bwaPeriod.findFirst({
            where: { id: parsed.data.basePeriodId, clientId },
            select: { id: true },
          });
          if (!p) throw new Error('BWA-Periode nicht gefunden.');
        }
        const plan = await tx.bwaPlan.create({
          data: {
            tenantId,
            clientId,
            name: parsed.data.name,
            year: parsed.data.year,
            basePeriodId: parsed.data.basePeriodId ?? null,
            notes: parsed.data.notes ?? null,
            status: parsed.data.status,
            createdBy: contactId,
            createdByType: 'CLIENT_CONTACT',
            updatedBy: contactId,
            updatedByType: 'CLIENT_CONTACT',
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
          actorType: 'CLIENT_CONTACT',
          actorId: contactId,
          action: 'bwa_plan.create',
          resourceType: 'bwa_plan',
          resourceId: plan.id,
          after: { name: parsed.data.name, year: parsed.data.year, lineCount: lines.length },
        });
        return plan.id;
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/portal/bwa');
  redirect(`/portal/bwa/plan/${id}`);
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

export async function updatePlanAction(input: z.infer<typeof UpdateSchema>): Promise<ActionResult> {
  const session = await portalAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  // S4: Portal-Schreib-Backstop.
  const rl = await checkPortalWriteLimit(session.user.contactId);
  if (!rl.ok) {
    return { ok: false, error: `Zu viele Aktionen. Bitte ${Math.ceil(rl.retryAfter / 60)} Min. warten.` };
  }
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, contactId, clientId } = session.user;
  const { planId } = parsed.data;

  try {
    await withTenantContext(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
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
            updatedBy: contactId,
            updatedByType: 'CLIENT_CONTACT',
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
          actorType: 'CLIENT_CONTACT',
          actorId: contactId,
          action: 'bwa_plan.update',
          resourceType: 'bwa_plan',
          resourceId: planId,
          after: { name: parsed.data.name, status: parsed.data.status, lineCount: parsed.data.lines.length },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/portal/bwa/plan/${planId}`);
  revalidatePath('/portal/bwa');
  return { ok: true };
}

export async function deletePlanAction(input: { planId: string }): Promise<ActionResult> {
  const session = await portalAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z.object({ planId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, contactId, clientId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      async (tx) => {
        const plan = await tx.bwaPlan.findUnique({ where: { id: parsed.data.planId } });
        if (!plan) throw new Error('Plan nicht gefunden.');
        if (plan.clientId !== clientId) throw new Error('Kein Zugriff.');
        await tx.bwaPlan.delete({ where: { id: parsed.data.planId } });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'CLIENT_CONTACT',
          actorId: contactId,
          action: 'bwa_plan.delete',
          resourceType: 'bwa_plan',
          resourceId: parsed.data.planId,
          before: { name: plan.name, year: plan.year },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/portal/bwa');
  return { ok: true };
}
