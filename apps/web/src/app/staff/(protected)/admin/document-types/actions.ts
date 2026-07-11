'use server';

import { z } from 'zod';
import { evidenceService } from '@/server/container';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

const REVALIDATE = '/staff/admin/document-types';
const NAME_TAKEN = 'Ein Typ mit diesem Namen existiert bereits.';
const TIERS = ['NONE', 'GWG', 'GOBD'] as const;

// ---------------------------------------------------------------------------
// Eigenen Typ anlegen. tier wird BEI ANLAGE festgelegt und ist danach
// unveränderbar — sonst müsste man bei nachträglicher Höherstufung alle
// bereits abgelegten Dokumente dieses Typs in den gelockten Bucket
// re-storen (kaskadierender Compliance-Eingriff). Andere Stufe gewünscht
// → neuen Typ anlegen.
// ---------------------------------------------------------------------------
const CreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name fehlt.').max(120),
    tier: z.enum(TIERS),
    retentionYears: z.union([z.literal(6), z.literal(8), z.literal(10)]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.tier === 'GOBD' && value.retentionYears === undefined) {
      ctx.addIssue({ code: 'custom', path: ['retentionYears'], message: 'GoBD-Frist fehlt.' });
    }
    if (value.tier !== 'GOBD' && value.retentionYears !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['retentionYears'],
        message: 'Frist passt nicht zur Stufe.',
      });
    }
  });

export async function createDocumentTypeAction(
  input: z.infer<typeof CreateSchema>,
): Promise<ActionResult> {
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const name = parsed.data.name.trim();

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const last = await tx.documentType.findFirst({
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const created = await tx.documentType.create({
        data: {
          tenantId,
          name,
          tier: parsed.data.tier,
          retentionYears:
            parsed.data.tier === 'GOBD'
              ? parsed.data.retentionYears
              : parsed.data.tier === 'GWG'
                ? 5
                : null,
          builtin: false,
          active: true,
          sortOrder: (last?.sortOrder ?? 0) + 10,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document_type.create',
        resourceType: 'document_type',
        resourceId: created.id,
        after: {
          name,
          tier: parsed.data.tier,
          retentionYears:
            parsed.data.tier === 'GOBD'
              ? parsed.data.retentionYears
              : parsed.data.tier === 'GWG'
                ? 5
                : null,
        },
      });
    },
    { requireAdmin: true, uniqueError: NAME_TAKEN, revalidate: REVALIDATE },
  );
}

// ---------------------------------------------------------------------------
// Eigenen Typ umbenennen / (de)aktivieren. Kern-Typen (builtin) sind tabu,
// ebenso die Stufe (unveränderbar, s. o.).
// ---------------------------------------------------------------------------
const UpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  active: z.boolean(),
});

export async function updateDocumentTypeAction(
  input: z.infer<typeof UpdateSchema>,
): Promise<ActionResult> {
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const name = parsed.data.name.trim();

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const t = await tx.documentType.findFirst({
        where: { id: parsed.data.id, tenantId },
        select: { builtin: true, name: true, active: true },
      });
      if (!t) throw new ActionError('Typ nicht gefunden.');
      if (t.builtin) throw new ActionError('Kern-Typen sind nicht veränderbar.');
      await tx.documentType.update({
        where: { id: parsed.data.id },
        data: { name, active: parsed.data.active },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document_type.update',
        resourceType: 'document_type',
        resourceId: parsed.data.id,
        before: { name: t.name, active: t.active },
        after: { name, active: parsed.data.active },
      });
    },
    { requireAdmin: true, uniqueError: NAME_TAKEN, revalidate: REVALIDATE },
  );
}

// ---------------------------------------------------------------------------
// Eigenen Typ löschen — nur wenn KEIN Dokument darauf zeigt (sonst
// deaktivieren). Kern-Typen tabu.
// ---------------------------------------------------------------------------
export async function deleteDocumentTypeAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const t = await tx.documentType.findFirst({
        where: { id: parsed.data.id, tenantId },
        select: { builtin: true, name: true },
      });
      if (!t) throw new ActionError('Typ nicht gefunden.');
      if (t.builtin) throw new ActionError('Kern-Typen können nicht gelöscht werden.');
      const inUse = await tx.document.count({
        where: { tenantId, documentTypeId: parsed.data.id },
      });
      if (inUse > 0) {
        throw new ActionError(
          `Typ wird von ${inUse} Dokument(en) genutzt — bitte stattdessen deaktivieren.`,
        );
      }
      await tx.documentType.delete({ where: { id: parsed.data.id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'document_type.delete',
        resourceType: 'document_type',
        resourceId: parsed.data.id,
        before: { name: t.name },
      });
    },
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}
