'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const SLUG_RE = /^[a-z][a-z0-9_]{1,40}$/;

const CreateSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Slug: nur a-z, 0-9, _ (Start mit Buchstabe).'),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  appliesTo: z.string().max(60).nullable().optional(),
});

export async function createStateMachineAction(input: z.infer<typeof CreateSchema>): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = CreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  let id: string;
  try {
    id = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // S7: expliziter tenantId-Filter (Defense in Depth + lesbarere Intent).
        const dup = await tx.stateMachine.findFirst({ where: { tenantId, slug: parsed.data.slug } });
        if (dup) throw new Error('Slug bereits vergeben.');
        const m = await tx.stateMachine.create({
          data: {
            tenantId,
            slug: parsed.data.slug,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            appliesTo: parsed.data.appliesTo ?? null,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'state_machine.create',
          resourceType: 'state_machine',
          resourceId: m.id,
          after: { slug: parsed.data.slug, name: parsed.data.name },
        });
        return m.id;
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/state-machines');
  redirect(`/staff/admin/state-machines/${id}`);
}

const UpdateMetaSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  appliesTo: z.string().max(60).nullable().optional(),
  active: z.boolean(),
});

export async function updateMachineMetaAction(
  input: z.infer<typeof UpdateMetaSchema>,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = UpdateMetaSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const before = await tx.stateMachine.findUnique({
          where: { id: parsed.data.id },
          select: { name: true, description: true, appliesTo: true, active: true },
        });
        if (!before) throw new Error('Status-Maschine nicht gefunden.');
        await tx.stateMachine.update({
          where: { id: parsed.data.id },
          data: {
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            appliesTo: parsed.data.appliesTo ?? null,
            active: parsed.data.active,
          },
        });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'state_machine.update',
          resourceType: 'state_machine',
          resourceId: parsed.data.id,
          before,
          after: {
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            appliesTo: parsed.data.appliesTo ?? null,
            active: parsed.data.active,
          },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/staff/admin/state-machines/${parsed.data.id}`);
  revalidatePath('/staff/admin/state-machines');
  return { ok: true };
}

export async function deleteMachineAction(input: { id: string }): Promise<ActionResult> {
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
        const m = await tx.stateMachine.findUnique({ where: { id: parsed.data.id } });
        if (!m) throw new Error('Status-Maschine nicht gefunden.');
        await tx.stateMachine.delete({ where: { id: parsed.data.id } });
        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'state_machine.delete',
          resourceType: 'state_machine',
          resourceId: parsed.data.id,
          before: { slug: m.slug, name: m.name },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/admin/state-machines');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Zustände + Übergänge — atomar speichern (komplette Definition ersetzen)
// ---------------------------------------------------------------------------

const StateInput = z.object({
  // null = neuer Zustand
  id: z.string().uuid().nullable(),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  label: z.string().min(1).max(80),
  color: z.string().max(20).nullable(),
  isInitial: z.boolean(),
  isTerminal: z.boolean(),
});
const TransitionInput = z.object({
  fromKey: z.string(),
  toKey: z.string(),
  label: z.string().min(1).max(80),
  conditionNote: z.string().max(300).nullable(),
});
const SaveDefinitionSchema = z.object({
  machineId: z.string().uuid(),
  states: z.array(StateInput).max(40),
  transitions: z.array(TransitionInput).max(200),
});

export async function saveMachineDefinitionAction(
  input: z.infer<typeof SaveDefinitionSchema>,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = SaveDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  const { machineId, states, transitions } = parsed.data;

  // Validierungen
  const keys = new Set<string>();
  for (const s of states) {
    if (keys.has(s.key)) return { ok: false, error: `Doppelter Zustand-Key: ${s.key}` };
    keys.add(s.key);
  }
  const initials = states.filter((s) => s.isInitial);
  if (states.length > 0 && initials.length !== 1) {
    return { ok: false, error: 'Genau ein Anfangszustand erforderlich.' };
  }
  for (const t of transitions) {
    if (!keys.has(t.fromKey)) return { ok: false, error: `Übergang verweist auf unbekannten Zustand: ${t.fromKey}` };
    if (!keys.has(t.toKey)) return { ok: false, error: `Übergang verweist auf unbekannten Zustand: ${t.toKey}` };
  }

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        const machine = await tx.stateMachine.findUnique({ where: { id: machineId } });
        if (!machine) throw new Error('Status-Maschine nicht gefunden.');

        // Upsert states by key
        const existing = await tx.stateMachineState.findMany({ where: { machineId } });
        const existingByKey = new Map(existing.map((s) => [s.key, s]));

        const keptIds = new Set<string>();
        let position = 0;
        for (const s of states) {
          const ex = existingByKey.get(s.key);
          if (ex) {
            await tx.stateMachineState.update({
              where: { id: ex.id },
              data: {
                label: s.label,
                color: s.color,
                isInitial: s.isInitial,
                isTerminal: s.isTerminal,
                position: position++,
              },
            });
            keptIds.add(ex.id);
          } else {
            const created = await tx.stateMachineState.create({
              data: {
                tenantId, machineId,
                key: s.key, label: s.label, color: s.color,
                isInitial: s.isInitial, isTerminal: s.isTerminal,
                position: position++,
              },
            });
            keptIds.add(created.id);
          }
        }
        // States entfernen, die nicht mehr drin sind (CASCADE räumt Transitionen)
        const toRemove = existing.filter((s) => !keptIds.has(s.id));
        if (toRemove.length > 0) {
          await tx.stateMachineState.deleteMany({
            where: { id: { in: toRemove.map((s) => s.id) } },
          });
        }

        // Transitionen komplett neu schreiben
        await tx.stateMachineTransition.deleteMany({ where: { machineId } });
        const refreshedStates = await tx.stateMachineState.findMany({ where: { machineId } });
        const stateIdByKey = new Map(refreshedStates.map((s) => [s.key, s.id]));
        for (const t of transitions) {
          await tx.stateMachineTransition.create({
            data: {
              tenantId, machineId,
              fromStateId: stateIdByKey.get(t.fromKey)!,
              toStateId: stateIdByKey.get(t.toKey)!,
              label: t.label,
              conditionNote: t.conditionNote,
            },
          });
        }

        await evidenceService.record(tx, {
          tenantId,
          actorType: 'STAFF',
          actorId: staffId,
          action: 'state_machine.definition.save',
          resourceType: 'state_machine',
          resourceId: machineId,
          after: { stateCount: states.length, transitionCount: transitions.length },
        });
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath(`/staff/admin/state-machines/${machineId}`);
  return { ok: true };
}
