'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const TIERS = ['NONE', 'GWG', 'GOBD'] as const;

// ---------------------------------------------------------------------------
// Eigenen Typ anlegen. tier wird BEI ANLAGE festgelegt und ist danach
// unveränderbar — sonst müsste man bei nachträglicher Höherstufung alle
// bereits abgelegten Dokumente dieses Typs in den gelockten Bucket
// re-storen (kaskadierender Compliance-Eingriff). Andere Stufe gewünscht
// → neuen Typ anlegen.
// ---------------------------------------------------------------------------
const CreateSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt.').max(120),
  tier: z.enum(TIERS),
});

export async function createDocumentTypeAction(
  input: z.infer<typeof CreateSchema>,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }
  const { tenantId, staffId } = session.user;
  const name = parsed.data.name.trim();

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const last = await tx.documentType.findFirst({
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        const created = await tx.documentType.create({
          data: {
            tenantId,
            name,
            tier: parsed.data.tier,
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
          after: { name, tier: parsed.data.tier },
        });
      },
    );
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Ein Typ mit diesem Namen existiert bereits.' };
    }
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/document-types');
  return { ok: true };
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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = UpdateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const name = parsed.data.name.trim();

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const t = await tx.documentType.findFirst({
          where: { id: parsed.data.id, tenantId },
          select: { builtin: true, name: true, active: true },
        });
        if (!t) throw new Error('Typ nicht gefunden.');
        if (t.builtin) throw new Error('Kern-Typen sind nicht veränderbar.');
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
    );
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      return { ok: false, error: 'Ein Typ mit diesem Namen existiert bereits.' };
    }
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/document-types');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Eigenen Typ löschen — nur wenn KEIN Dokument darauf zeigt (sonst
// deaktivieren). Kern-Typen tabu.
// ---------------------------------------------------------------------------
export async function deleteDocumentTypeAction(input: {
  id: string;
}): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const t = await tx.documentType.findFirst({
          where: { id: parsed.data.id, tenantId },
          select: { builtin: true, name: true },
        });
        if (!t) throw new Error('Typ nicht gefunden.');
        if (t.builtin) throw new Error('Kern-Typen können nicht gelöscht werden.');
        const inUse = await tx.document.count({
          where: { tenantId, documentTypeId: parsed.data.id },
        });
        if (inUse > 0) {
          throw new Error(
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
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/document-types');
  return { ok: true };
}
