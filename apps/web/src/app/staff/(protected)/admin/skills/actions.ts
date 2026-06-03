'use server';

import { z } from 'zod';
import { evidenceService } from '@/server/container';
import { assertStaffInTenant } from '@/server/db/assert-tenant';
import { withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

const REVALIDATE = '/staff/admin/skills';
const SLUG_RE = /^[A-Z0-9_]+$/;
const COLOR_VALUES = ['blue', 'amber', 'emerald', 'purple', 'pink', 'red', 'yellow', 'gray'] as const;

const CreateSchema = z.object({
  slug: z.string().min(2).max(40).regex(SLUG_RE),
  label: z.string().min(2).max(100),
  color: z.string().optional(),
});

export async function createSkillAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = CreateSchema.safeParse({
    slug: formData.get('slug'),
    label: formData.get('label'),
    color: formData.get('color') ?? '',
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  const color =
    parsed.data.color && (COLOR_VALUES as readonly string[]).includes(parsed.data.color) ? parsed.data.color : null;

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const dup = await tx.staffSkill.findFirst({ where: { slug: parsed.data.slug } });
      if (dup) throw new ActionError('Kürzel bereits vergeben.');
      const created = await tx.staffSkill.create({
        data: { tenantId, slug: parsed.data.slug, label: parsed.data.label, color, isSystem: false },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff_skill.create',
        resourceType: 'staff_skill',
        resourceId: created.id,
        after: { slug: parsed.data.slug, label: parsed.data.label, color },
      });
    },
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}

export async function updateSkillAction(input: {
  id: string;
  label: string;
  color: string | null;
}): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.string().uuid(), label: z.string().min(2).max(100), color: z.enum(COLOR_VALUES).nullable() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const before = await tx.staffSkill.findUnique({
        where: { id: parsed.data.id },
        select: { label: true, color: true },
      });
      if (!before) throw new ActionError('Skill nicht gefunden.');
      await tx.staffSkill.update({
        where: { id: parsed.data.id },
        data: { label: parsed.data.label, color: parsed.data.color },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff_skill.update',
        resourceType: 'staff_skill',
        resourceId: parsed.data.id,
        before,
        after: { label: parsed.data.label, color: parsed.data.color },
      });
    },
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}

export async function deleteSkillAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const skill = await tx.staffSkill.findUnique({ where: { id: parsed.data.id } });
      if (!skill) throw new ActionError('Skill nicht gefunden.');
      if (skill.isSystem) throw new ActionError('System-Bereiche können nicht gelöscht werden.');
      await tx.staffSkill.delete({ where: { id: parsed.data.id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'staff_skill.delete',
        resourceType: 'staff_skill',
        resourceId: parsed.data.id,
        before: { slug: skill.slug, label: skill.label },
      });
    },
    { requireAdmin: true, revalidate: REVALIDATE },
  );
}

// ----------------------------------------------------------------------------
// Mitarbeiter-Skill-Zuordnung (wird von der Benutzer-Verwaltung aufgerufen)
// ----------------------------------------------------------------------------

export async function setStaffSkillsAction(input: {
  staffId: string;
  skillIds: string[];
}): Promise<ActionResult> {
  const parsed = z
    .object({ staffId: z.string().uuid(), skillIds: z.array(z.string().uuid()) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId: actorId }) => {
      // S-6: staffId + jede skillId müssen im aktuellen Tenant existieren. RLS
      // schützt Reads, FK prüft nur Cluster-weite Existenz — ohne diese Checks
      // könnte ein UI-Bug oder direkter Action-Call eine fremde staffId/skillId
      // verknüpfen. Symmetrisch zum R-2-Pattern.
      await assertStaffInTenant(tx, parsed.data.staffId);
      for (const sid of parsed.data.skillIds) {
        const skill = await tx.staffSkill.findFirst({ where: { id: sid }, select: { id: true } });
        if (!skill) throw new ActionError('Unbekannter Tätigkeitsbereich.');
      }

      const before = await tx.staffSkillAssignment.findMany({ where: { staffId: parsed.data.staffId } });
      const beforeIds = new Set(before.map((b) => b.skillId));
      const afterIds = new Set(parsed.data.skillIds);
      const toAdd = parsed.data.skillIds.filter((id) => !beforeIds.has(id));
      const toRemove = before.filter((b) => !afterIds.has(b.skillId)).map((b) => b.skillId);

      if (toRemove.length > 0) {
        await tx.staffSkillAssignment.deleteMany({
          where: { staffId: parsed.data.staffId, skillId: { in: toRemove } },
        });
      }
      for (const sid of toAdd) {
        await tx.staffSkillAssignment.create({ data: { staffId: parsed.data.staffId, skillId: sid } });
      }
      if (toAdd.length > 0 || toRemove.length > 0) {
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId,
          action: 'staff.skills.update',
          resourceType: 'staff_user',
          resourceId: parsed.data.staffId,
          before: { skillIds: Array.from(beforeIds) },
          after: { skillIds: parsed.data.skillIds },
        });
      }
    },
    { requireAdmin: true, revalidate: '/staff/admin/users' },
  );
}
