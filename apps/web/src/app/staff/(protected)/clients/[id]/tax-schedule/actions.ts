'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import type { TaxScheduleKind } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { materializeTaxDeadlines } from '@/server/tax-deadlines/materialize';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { staffActionGuard } from '@/server/actions/staff-action';

const ALL_KINDS: TaxScheduleKind[] = [
  'USTA_MONATLICH', 'USTA_QUARTAL', 'USTA_JAEHRLICH',
  'LSTA_MONATLICH', 'LSTA_QUARTAL', 'LSTA_JAEHRLICH',
  'EST_VZ', 'KST_VZ', 'GEWST_VZ',
  'EST_ERKLAERUNG', 'KST_ERKLAERUNG', 'GEWST_ERKLAERUNG',
];

export interface ActionResult {
  ok: boolean;
  error?: string;
  savedAt?: string;
}

export async function saveScheduleConfigAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  const parsed = z.string().uuid().safeParse(formData.get('clientId'));
  if (!parsed.success) return { ok: false, error: 'Ungültige Mandanten-ID.' };
  const clientId = parsed.data;

  // Pro Kind die drei Felder einsammeln
  const updates = ALL_KINDS.map((kind) => ({
    kind,
    active: formData.get(`active.${kind}`) === 'on',
    hasDauerfrist: formData.get(`dauerfrist.${kind}`) === 'on',
    reminderDaysBefore: clampInt(formData.get(`reminder.${kind}`), 0, 90, 10),
  }));

  await withTenantContext(
    ctx,
    async (tx) => {
      await assertClientAccessTx(tx, session, clientId);
      // R-2: clientId Tenant-Sanity vor allen taxScheduleConfig-Mutationen.
      await assertClientInTenant(tx, clientId);
      // Bestehende laden für Diff
      const existing = await tx.taxScheduleConfig.findMany({ where: { clientId } });
      const byKind = new Map(existing.map((c) => [c.kind, c]));

      for (const u of updates) {
        const old = byKind.get(u.kind);

        if (!u.active) {
          // Inaktiv: Wenn Eintrag existiert → auf active=false setzen UND
          // alle noch nicht erledigten Termine wegputzen, damit der Kalender
          // sauber ist. Erledigte Termine bleiben (Audit-relevant).
          if (old && old.active) {
            const removed = await tx.taxDeadline.deleteMany({
              where: {
                clientId,
                kind: u.kind,
                status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] },
              },
            });
            await tx.taxScheduleConfig.update({
              where: { id: old.id },
              data: { active: false },
            });
            await evidenceService.record(tx, {
              tenantId,
              actorType: 'STAFF',
              actorId: staffId,
              action: 'tax_schedule.deactivate',
              resourceType: 'tax_schedule_config',
              resourceId: old.id,
              before: { active: true },
              after: { active: false, removedDeadlines: removed.count },
            });
          }
          continue;
        }

        // Aktiv: Upsert
        if (old) {
          await tx.taxScheduleConfig.update({
            where: { id: old.id },
            data: {
              active: true,
              hasDauerfrist: u.hasDauerfrist,
              reminderDaysBefore: u.reminderDaysBefore,
            },
          });
        } else {
          const created = await tx.taxScheduleConfig.create({
            data: {
              tenantId,
              clientId,
              kind: u.kind,
              active: true,
              hasDauerfrist: u.hasDauerfrist,
              reminderDaysBefore: u.reminderDaysBefore,
              createdByStaff: staffId,
            },
          });
          await evidenceService.record(tx, {
            tenantId,
            actorType: 'STAFF',
            actorId: staffId,
            action: 'tax_schedule.create',
            resourceType: 'tax_schedule_config',
            resourceId: created.id,
            after: { kind: u.kind, hasDauerfrist: u.hasDauerfrist, reminderDaysBefore: u.reminderDaysBefore },
          });
        }
      }
    },
  );

  // Direkt materialisieren, damit die neuen aktiven Termine sofort sichtbar sind
  await materializeTaxDeadlines(
    ctx,
    { systemStaffId: staffId },
  );

  revalidatePath(`/staff/clients/${clientId}/tax-schedule`);
  revalidatePath('/staff/tax-deadlines');
  return { ok: true, savedAt: new Date().toISOString() };
}

function clampInt(v: FormDataEntryValue | null, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
