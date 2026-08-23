'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { executeWorkflowStep, type ExecuteResult } from '@/server/workflows/execute-step';
import { parseStepConfig } from '@/server/workflows/step-config';
import { assertClientInTenant, assertStaffInTenant } from '@/server/db/assert-tenant';
import { assertClientAccessTx, toActionError } from '@/server/auth/rbac';
import {
  staffActionGuard,
  withStaffModule,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

const withWorkflowsStaff = withStaffModule('workflows');

function revalidateClientWorkflow(clientId: string | undefined): void {
  if (clientId) revalidatePath(`/staff/clients/${clientId}`);
}

// Einheitliches Action-Ergebnis aus der zentralen Quelle.
export type ActionResult = BaseActionResult;

// Startet eine Workflow-Instanz — entweder aus einer Vorlage (Schritte werden
// kopiert) ODER als „eigener Workflow" (einmalig, ohne Vorlage: freier Name,
// keine Schritte → der/die Bearbeiter:in fügt Schritte ad-hoc via AddStepForm
// hinzu). Genau eines von beidem (Vorlage XOR Name) muss da sein.
export async function startInstanceAction(input: {
  clientId: string;
  templateId?: string;
  name?: string;
  memberIds?: string[];
  analysisId?: string;
}) {
  const parsed = z
    .object({
      clientId: z.string().uuid(),
      templateId: z.string().uuid().optional(),
      name: z.string().trim().min(1).max(200).optional(),
      memberIds: z.array(z.string().uuid()).max(50).optional(),
      analysisId: z.string().uuid().nullable().optional(),
    })
    .refine((d) => Boolean(d.templateId) || Boolean(d.name), {
      message: 'Vorlage wählen oder einen Namen für den eigenen Workflow angeben.',
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'Validierungsfehler.' };
  }

  return withWorkflowsStaff(
    async (tx, { tenantId, staffId, session }) => {
      await assertClientAccessTx(tx, session, parsed.data.clientId);
      // Tenant-Sanity: clientId + (optional) analysisId müssen zu diesem Tenant
      // gehören. FK/RLS sind der Backstop; hier ein klarer Fehler statt FK-Bruch.
      await assertClientInTenant(tx, parsed.data.clientId);
      if (parsed.data.analysisId) {
        const a = await tx.riskAnalysis.findFirst({
          where: { id: parsed.data.analysisId },
          select: { id: true },
        });
        if (!a) throw new ActionError('Sachverhalt nicht gefunden oder nicht in diesem Tenant.');
      }

      const startedAt = new Date();

      // Vorlage laden (nur im Vorlagen-Modus). Bei „eigener Workflow" bleibt tpl null.
      const tpl = parsed.data.templateId
        ? await tx.workflowTemplate.findUnique({
            where: { id: parsed.data.templateId },
            include: { steps: { orderBy: { position: 'asc' } } },
          })
        : null;
      if (parsed.data.templateId) {
        if (!tpl) throw new ActionError('Vorlage nicht gefunden.');
        if (!tpl.active) throw new ActionError('Vorlage ist deaktiviert.');
        if (tpl.steps.length === 0) throw new ActionError('Vorlage hat keine Schritte.');
      }

      const name = tpl ? tpl.name : (parsed.data.name ?? 'Eigener Workflow');
      const stepCount = tpl ? tpl.steps.length : 0;
      // Items nur im Vorlagen-Modus aus den Schritten erzeugen; eigener Workflow
      // startet leer (Schritte folgen ad-hoc).
      const items = tpl
        ? tpl.steps.map((s) => ({
            position: s.position,
            title: s.title,
            description: s.description,
            skillId: s.skillId,
            kind: s.kind,
            config: s.config as object,
            n8nEvent: s.n8nEvent,
            // Default-Assignee: der Starter des Workflows. Kann pro Item
            // nachträglich geändert werden (Skill-Auswahl im Item-Row).
            assigneeStaffId: staffId,
            dueDate:
              s.dueAfterDays != null
                ? new Date(startedAt.getTime() + s.dueAfterDays * 24 * 60 * 60 * 1000)
                : null,
          }))
        : undefined;

      const inst = await tx.workflowInstance.create({
        data: {
          tenantId,
          clientId: parsed.data.clientId,
          analysisId: parsed.data.analysisId ?? null,
          templateId: tpl?.id ?? null,
          name,
          startedByStaff: staffId,
          startedAt,
          ...(items ? { items: { create: items } } : {}),
        },
      });
      // Mitglieder aufnehmen — immer mindestens der Starter selbst
      const memberSet = new Set<string>([staffId, ...(parsed.data.memberIds ?? [])]);
      await tx.workflowInstanceMember.createMany({
        data: Array.from(memberSet).map((sid) => ({
          instanceId: inst.id,
          staffId: sid,
          addedBy: staffId,
        })),
        skipDuplicates: true,
      });

      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'workflow.instance.start',
        resourceType: 'workflow_instance',
        resourceId: inst.id,
        after: {
          name,
          clientId: parsed.data.clientId,
          stepCount,
          memberCount: memberSet.size,
          fromTemplate: tpl != null,
        },
      });
    },
    {
      revalidate: parsed.data.analysisId
        ? [
            `/staff/clients/${parsed.data.clientId}/workflows`,
            `/staff/clients/${parsed.data.clientId}/subsumtion/${parsed.data.analysisId}`,
          ]
        : `/staff/clients/${parsed.data.clientId}/workflows`,
    },
  );
}

/**
 * Setzt die Mitglieder einer Workflow-Instanz neu. Macht ein Diff und legt
 * neue Member an / entfernt entfernte. Starter kann nie entfernt werden.
 */
export async function setWorkflowMembersAction(input: { instanceId: string; memberIds: string[] }) {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      memberIds: z.array(z.string().uuid()).max(50),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
      include: { members: { select: { staffId: true } } },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    await assertClientAccessTx(tx, session, inst.clientId);

    const want = new Set<string>([inst.startedByStaff, ...parsed.data.memberIds]);
    const have = new Set(inst.members.map((m) => m.staffId));
    const toAdd = Array.from(want).filter((s) => !have.has(s));
    const toRemove = Array.from(have).filter((s) => !want.has(s));

    // R-2: Jede staffId, die neu hinzugefügt werden soll, muss im
    // aktuellen Tenant existieren. RLS filtert Reads, aber FK prüft nur
    // Cluster-weite Existenz — sonst kann ein UI-Bug einen Cross-Tenant-
    // Staff persistieren.
    for (const sid of toAdd) {
      await assertStaffInTenant(tx, sid);
    }

    if (toAdd.length > 0) {
      await tx.workflowInstanceMember.createMany({
        data: toAdd.map((sid) => ({
          instanceId: parsed.data.instanceId,
          staffId: sid,
          addedBy: staffId,
        })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length > 0) {
      await tx.workflowInstanceMember.deleteMany({
        where: {
          instanceId: parsed.data.instanceId,
          staffId: { in: toRemove },
        },
      });
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'workflow.instance.members_update',
        resourceType: 'workflow_instance',
        resourceId: parsed.data.instanceId,
        after: { added: toAdd, removed: toRemove, total: want.size },
      });
    }
    return { clientId: inst.clientId };
  });
  if (r.ok) revalidateClientWorkflow(r.clientId);
  return r;
}

export async function toggleItemDoneAction(input: { id: string; done: boolean }) {
  const parsed = z.object({ id: z.string().uuid(), done: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { staffId, session }) => {
    const existing = await tx.workflowItem.findUnique({
      where: { id: parsed.data.id },
      select: { instance: { select: { clientId: true } } },
    });
    if (!existing) throw new ActionError('Schritt nicht gefunden.');
    await assertClientAccessTx(tx, session, existing.instance.clientId);
    const item = await tx.workflowItem.update({
      where: { id: parsed.data.id },
      data: parsed.data.done
        ? { doneAt: new Date(), doneByStaff: staffId }
        : { doneAt: null, doneByStaff: null },
    });
    // Wenn alle Items erledigt → Instanz auf COMPLETED
    const remaining = await tx.workflowItem.count({
      where: { instanceId: item.instanceId, doneAt: null },
    });
    if (parsed.data.done && remaining === 0) {
      await tx.workflowInstance.update({
        where: { id: item.instanceId },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    } else if (!parsed.data.done) {
      await tx.workflowInstance.updateMany({
        where: { id: item.instanceId, status: 'COMPLETED' },
        data: { status: 'ACTIVE', completedAt: null },
      });
    }
    return { clientId: existing.instance.clientId };
  });
  if (r.ok) revalidateClientWorkflow(r.clientId);
  return r;
}

/**
 * Setzt das Fälligkeitsdatum eines Workflow-Items. Nutzt der Bearbeiter, um
 * vom Default des Step abzuweichen (z. B. längere Frist für einen
 * bestimmten Mandanten).
 */
export async function setItemDueDateAction(input: {
  id: string;
  dueDate: string | null; // ISO-Date 'YYYY-MM-DD' oder null
}) {
  const parsed = z
    .object({
      id: z.string().uuid(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum als YYYY-MM-DD')
        .nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  // R-6: P2025-Mapping erledigt withStaff via toActionError.
  const r = await withWorkflowsStaff(async (tx, { session }) => {
    const existing = await tx.workflowItem.findUnique({
      where: { id: parsed.data.id },
      select: { instance: { select: { clientId: true } } },
    });
    if (!existing) throw new ActionError('Schritt nicht gefunden.');
    await assertClientAccessTx(tx, session, existing.instance.clientId);
    await tx.workflowItem.update({
      where: { id: parsed.data.id },
      data: { dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null },
    });
    return { clientId: existing.instance.clientId };
  });
  if (r.ok) revalidateClientWorkflow(r.clientId);
  return r;
}

export async function setItemAssigneeAction(input: { id: string; staffId: string | null }) {
  const parsed = z
    .object({
      id: z.string().uuid(),
      staffId: z.string().uuid().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { session }) => {
    const existing = await tx.workflowItem.findUnique({
      where: { id: parsed.data.id },
      select: { instance: { select: { clientId: true } } },
    });
    if (!existing) throw new ActionError('Schritt nicht gefunden.');
    await assertClientAccessTx(tx, session, existing.instance.clientId);
    // R-2: assigneeStaffId muss im aktuellen Tenant existieren (falls nicht null).
    if (parsed.data.staffId) {
      await assertStaffInTenant(tx, parsed.data.staffId);
    }
    await tx.workflowItem.update({
      where: { id: parsed.data.id },
      data: { assigneeStaffId: parsed.data.staffId },
    });
    return { clientId: existing.instance.clientId };
  });
  if (r.ok) revalidateClientWorkflow(r.clientId);
  return r;
}

/**
 * Bricht eine laufende Workflow-Instanz ab. Setzt den Status auf CANCELLED
 * und schreibt den Grund in `notes`. Bereits erledigte Items bleiben
 * erhalten (Historie); offene Items werden NICHT mehr als „offen" gezählt,
 * weil die Instanz nicht mehr ACTIVE ist.
 */
export async function cancelInstanceAction(input: { instanceId: string; reason: string }) {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      reason: z.string().min(3).max(2000),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    await assertClientAccessTx(tx, session, inst.clientId);
    if (inst.status !== 'ACTIVE' && inst.status !== 'PAUSED') {
      throw new ActionError('Workflow ist bereits abgeschlossen oder abgebrochen.');
    }

    const reasonLine = `[Abgebrochen am ${new Date().toISOString().slice(0, 16).replace('T', ' ')} von ${staffId}] ${parsed.data.reason}`;
    const merged = inst.notes ? `${inst.notes}\n\n${reasonLine}` : reasonLine;

    // TOCTOU-Schutz: nur aus ACTIVE/PAUSED heraus abbrechen (atomarer Claim).
    const claim = await tx.workflowInstance.updateMany({
      where: { id: parsed.data.instanceId, status: { in: ['ACTIVE', 'PAUSED'] } },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        notes: merged,
      },
    });
    if (claim.count === 0)
      throw new ActionError('Workflow-Status hat sich geändert — bitte Seite neu laden.');

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.instance.cancel',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      before: { status: 'ACTIVE' },
      after: { status: 'CANCELLED', reason: parsed.data.reason },
    });
    return { clientId: inst.clientId };
  });
  if (r.ok) {
    revalidateClientWorkflow(r.clientId);
    revalidatePath('/staff/workflows');
  }
  return r;
}

/**
 * Wiederherstellen aus dem Papierkorb: CANCELLED → ACTIVE. Notiz mit
 * Wiederherstellungs-Grund wird angehängt.
 */
export async function restoreInstanceAction(input: { instanceId: string }) {
  const parsed = z.object({ instanceId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const inst = await tx.workflowInstance.findUnique({ where: { id: parsed.data.instanceId } });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    await assertClientAccessTx(tx, session, inst.clientId);
    if (inst.status !== 'CANCELLED')
      throw new ActionError('Nur abgebrochene Workflows lassen sich wiederherstellen.');

    const line = `[Wiederhergestellt am ${new Date().toISOString().slice(0, 16).replace('T', ' ')}]`;
    // TOCTOU-Schutz: nur aus CANCELLED heraus wiederherstellen.
    const claim = await tx.workflowInstance.updateMany({
      where: { id: parsed.data.instanceId, status: 'CANCELLED' },
      data: {
        status: 'ACTIVE',
        completedAt: null,
        notes: inst.notes ? `${inst.notes}\n\n${line}` : line,
      },
    });
    if (claim.count === 0)
      throw new ActionError('Workflow-Status hat sich geändert — bitte Seite neu laden.');
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.instance.restore',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      before: { status: 'CANCELLED' },
      after: { status: 'ACTIVE' },
    });
    return { clientId: inst.clientId };
  });
  if (r.ok) {
    revalidateClientWorkflow(r.clientId);
    revalidatePath('/staff/workflows');
  }
  return r;
}

/**
 * Pausiert einen laufenden Workflow. Status → PAUSED. Optional bis zu einem
 * Datum — danach wird der Workflow beim nächsten Page-Load automatisch
 * wieder ACTIVE (Lazy-Resume in `autoResumePausedWorkflows`).
 */
export async function pauseInstanceAction(input: {
  instanceId: string;
  reason: string;
  until: string | null;
}) {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      reason: z.string().max(2000).optional().or(z.literal('')),
      until: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const inst = await tx.workflowInstance.findUnique({ where: { id: parsed.data.instanceId } });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    await assertClientAccessTx(tx, session, inst.clientId);
    if (inst.status !== 'ACTIVE')
      throw new ActionError('Nur aktive Workflows können pausiert werden.');

    const reasonText = (parsed.data.reason ?? '').trim();
    const until = parsed.data.until;
    const tag = `[Pausiert am ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${until ? ' bis ' + until : ''}]`;
    const reasonLine = reasonText ? `${tag} ${reasonText}` : tag;

    // TOCTOU-Schutz: nur aus ACTIVE heraus pausieren.
    const claim = await tx.workflowInstance.updateMany({
      where: { id: parsed.data.instanceId, status: 'ACTIVE' },
      data: {
        status: 'PAUSED',
        pausedUntil: until ? new Date(until) : null,
        notes: inst.notes ? `${inst.notes}\n\n${reasonLine}` : reasonLine,
      },
    });
    if (claim.count === 0)
      throw new ActionError('Workflow-Status hat sich geändert — bitte Seite neu laden.');
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.instance.pause',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      after: { status: 'PAUSED', pausedUntil: until, reason: reasonText || null },
    });
    return { clientId: inst.clientId };
  });
  if (r.ok) {
    revalidateClientWorkflow(r.clientId);
    revalidatePath('/staff/workflows');
  }
  return r;
}

/**
 * Manuelles Fortsetzen einer pausierten Instanz (vor dem `pausedUntil`-Datum).
 */
export async function resumeInstanceAction(input: { instanceId: string }) {
  const parsed = z.object({ instanceId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const inst = await tx.workflowInstance.findUnique({ where: { id: parsed.data.instanceId } });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    await assertClientAccessTx(tx, session, inst.clientId);
    if (inst.status !== 'PAUSED')
      throw new ActionError('Nur pausierte Workflows können fortgesetzt werden.');

    // TOCTOU-Schutz: nur aus PAUSED heraus fortsetzen.
    const claim = await tx.workflowInstance.updateMany({
      where: { id: parsed.data.instanceId, status: 'PAUSED' },
      data: { status: 'ACTIVE', pausedUntil: null },
    });
    if (claim.count === 0)
      throw new ActionError('Workflow-Status hat sich geändert — bitte Seite neu laden.');
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.instance.resume',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      before: { status: 'PAUSED' },
      after: { status: 'ACTIVE' },
    });
    return { clientId: inst.clientId };
  });
  if (r.ok) {
    revalidateClientWorkflow(r.clientId);
    revalidatePath('/staff/workflows');
  }
  return r;
}

/**
 * Hängt einen ad-hoc-Schritt an eine laufende Workflow-Instanz. Wird ans
 * Ende der Liste positioniert. Default kind=TASK; assigneeStaffId =
 * aktueller User.
 */
export async function addItemToInstanceAction(input: {
  instanceId: string;
  title: string;
  description?: string;
  dueDate?: string | null;
  kind?:
    | 'TASK'
    | 'DOCUMENT_UPLOAD'
    | 'CLIENT_REQUEST'
    | 'CLIENT_FORM'
    | 'CLIENT_EMAIL'
    | 'N8N_TRIGGER';
  config?: unknown;
  n8nEvent?: string | null;
  assigneeStaffId?: string | null;
}) {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      title: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      kind: z
        .enum([
          'TASK',
          'DOCUMENT_UPLOAD',
          'CLIENT_REQUEST',
          'CLIENT_FORM',
          'CLIENT_EMAIL',
          'N8N_TRIGGER',
        ])
        .default('TASK'),
      config: z.unknown().optional(),
      n8nEvent: z.string().max(100).nullable().optional(),
      assigneeStaffId: z.string().uuid().nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const kind = parsed.data.kind ?? 'TASK';
  const configResult = parseStepConfig(kind, parsed.data.config);
  if (!configResult.ok) return { ok: false as const, error: `Kind ${kind}: ${configResult.error}` };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
      include: { items: { orderBy: { position: 'desc' }, take: 1, select: { position: true } } },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    await assertClientAccessTx(tx, session, inst.clientId);
    if (inst.status === 'COMPLETED' || inst.status === 'CANCELLED') {
      throw new ActionError('Workflow ist abgeschlossen oder abgebrochen.');
    }
    const nextPos = (inst.items[0]?.position ?? -1) + 1;
    const item = await tx.workflowItem.create({
      data: {
        instanceId: parsed.data.instanceId,
        position: nextPos,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        assigneeStaffId:
          parsed.data.assigneeStaffId === undefined ? staffId : parsed.data.assigneeStaffId,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        kind,
        config: configResult.value as object,
        n8nEvent: parsed.data.n8nEvent?.trim() || null,
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.item.add',
      resourceType: 'workflow_item',
      resourceId: item.id,
      after: { instanceId: parsed.data.instanceId, title: parsed.data.title, kind, adHoc: true },
    });
    return { clientId: inst.clientId };
  });
  if (r.ok) revalidateClientWorkflow(r.clientId);
  return r;
}

/**
 * Schritt-Übergabe mit Kommentar: ändert assignee und legt automatisch
 * einen WorkflowItemComment an („Übergabe von X an Y: …"). So bleibt im
 * Verlauf nachvollziehbar, wer wann an wen übergeben hat.
 */
export async function handoverItemAction(input: {
  itemId: string;
  toStaffId: string;
  note: string;
}) {
  const parsed = z
    .object({
      itemId: z.string().uuid(),
      toStaffId: z.string().uuid(),
      note: z.string().max(2000).optional().or(z.literal('')),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const myName = session.user.name ?? 'Ich';
    const item = await tx.workflowItem.findUnique({
      where: { id: parsed.data.itemId },
      include: { instance: { select: { clientId: true } } },
    });
    if (!item) throw new ActionError('Schritt nicht gefunden.');
    await assertClientAccessTx(tx, session, item.instance.clientId);
    if (item.doneAt) throw new ActionError('Schritt ist bereits erledigt.');
    if (parsed.data.toStaffId === item.assigneeStaffId) {
      throw new ActionError('Empfänger ist bereits Bearbeiter.');
    }
    const toUser = await tx.staffUser.findUnique({
      where: { id: parsed.data.toStaffId },
      select: { fullName: true, active: true },
    });
    if (!toUser || !toUser.active) throw new ActionError('Empfänger nicht gefunden oder inaktiv.');

    await tx.workflowItem.update({
      where: { id: parsed.data.itemId },
      data: { assigneeStaffId: parsed.data.toStaffId },
    });
    const note = (parsed.data.note ?? '').trim();
    await tx.workflowItemComment.create({
      data: {
        itemId: parsed.data.itemId,
        authorStaffId: staffId,
        authorName: myName,
        body: note
          ? `📋 Übergabe an ${toUser.fullName}: ${note}`
          : `📋 Übergabe an ${toUser.fullName}`,
      },
    });
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.item.handover',
      resourceType: 'workflow_item',
      resourceId: item.id,
      before: { assigneeStaffId: item.assigneeStaffId },
      after: { assigneeStaffId: parsed.data.toStaffId, note: note || null },
    });
    return { clientId: item.instance.clientId };
  });
  if (r.ok) revalidateClientWorkflow(r.clientId);
  return r;
}

/**
 * Kommentar zu einem Workflow-Item anlegen.
 */
export async function addItemCommentAction(input: { itemId: string; body: string }) {
  const parsed = z
    .object({
      itemId: z.string().uuid(),
      body: z.string().min(1).max(5000),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const authorName = session.user.name ?? 'Mitarbeiter';
    const item = await tx.workflowItem.findUnique({
      where: { id: parsed.data.itemId },
      select: { id: true, instance: { select: { clientId: true } } },
    });
    if (!item) throw new ActionError('Schritt nicht gefunden.');
    await assertClientAccessTx(tx, session, item.instance.clientId);
    const commentBody = parsed.data.body.trim();
    const comment = await tx.workflowItemComment.create({
      data: {
        itemId: parsed.data.itemId,
        authorStaffId: staffId,
        authorName,
        body: commentBody,
      },
    });
    // V-3: Audit-Eintrag für Kommentar — Symmetrie zu allen anderen
    // state-changing Workflow-Actions (workflow.template.update,
    // workflow.item.add, workflow.item.execute …). Body-Länge statt -Inhalt,
    // damit Mandantengeheimnisse aus Kommentartexten nicht ins Audit-Log
    // bleeden (Audit-Pflicht ist „wer wann was dokumentiert hat", nicht
    // „was genau geschrieben wurde").
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.item.comment',
      resourceType: 'workflow_item',
      resourceId: parsed.data.itemId,
      after: { commentId: comment.id, length: commentBody.length },
    });
    return { clientId: item.instance.clientId };
  });
  if (r.ok) revalidateClientWorkflow(r.clientId);
  return r;
}

/**
 * Endgültiges Löschen einer abgebrochenen Workflow-Instanz (Stufe 2).
 *
 * Nur erlaubt, wenn die Instanz bereits den Status `CANCELLED` hat — also
 * vorher über `cancelInstanceAction` „in den Papierkorb" gewandert ist. So
 * kann nichts versehentlich verschwinden. Cascade löscht alle Items.
 *
 * Trotz Lösch-Aktion bleibt der Audit-Trail erhalten (audit_log ist
 * insert-only). Per Workflow-Item erzeugte Anforderungen und
 * Form-Submissions werden NICHT gelöscht — deren workflow_item_id wird per
 * onDelete SetNull genullt.
 */
export async function deleteCancelledInstanceAction(input: { instanceId: string }) {
  const parsed = z.object({ instanceId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withWorkflowsStaff(async (tx, { tenantId, staffId, session }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    await assertClientAccessTx(tx, session, inst.clientId);
    if (inst.status !== 'CANCELLED') {
      throw new ActionError('Nur abgebrochene Workflows können endgültig gelöscht werden.');
    }

    // TOCTOU-Schutz: nur löschen, solange noch CANCELLED. Race gegen restore
    // (CANCELLED → ACTIVE) darf keine wieder aktive Instanz endgültig löschen.
    const del = await tx.workflowInstance.deleteMany({
      where: { id: parsed.data.instanceId, status: 'CANCELLED' },
    });
    if (del.count === 0) {
      throw new ActionError('Workflow-Status hat sich geändert — bitte Seite neu laden.');
    }

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'workflow.instance.delete',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      before: { name: inst.name, status: inst.status, notes: inst.notes },
    });
    return { clientId: inst.clientId };
  });
  if (r.ok) {
    revalidateClientWorkflow(r.clientId);
    revalidatePath('/staff/workflows');
  }
  return r;
}

/**
 * Stößt einen Workflow-Schritt an — je nach `kind`:
 *   - TASK: sofort als done markieren (Äquivalent zum Häkchen).
 *   - CLIENT_REQUEST / CLIENT_FORM: erzeugt Folge-Artefakt, Item wartet bis
 *     der Mandant antwortet bzw. das Formular abschickt.
 *   - CLIENT_EMAIL: Mail raus, Item done.
 *   - N8N_TRIGGER: nur Webhook, Item done.
 *   - DOCUMENT_UPLOAD: markiert nur als „angestoßen"; die eigentliche
 *     Erledigung passiert über den Upload-Flow.
 */
export async function executeItemAction(input: {
  id: string;
}): Promise<ActionResult & ExecuteResult> {
  const g = await staffActionGuard({ module: 'workflows' });
  if (!g.ok) return g;
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // Vertraulich-/RESTRICTED-Ventil: executeWorkflowStep prüft den Mandanten-
  // Zugriff selbst NICHT — daher hier vor der Delegation über die Instanz des
  // Items den Zugriff sicherstellen.
  let clientId: string;
  try {
    clientId = await withTenantContext(g.ctx, async (tx) => {
      const item = await tx.workflowItem.findUnique({
        where: { id: parsed.data.id },
        select: { instance: { select: { clientId: true } } },
      });
      if (!item) throw new ActionError('Schritt nicht gefunden.');
      await assertClientAccessTx(tx, g.session, item.instance.clientId);
      return item.instance.clientId;
    });
  } catch (e) {
    return toActionError(e);
  }

  const result = await executeWorkflowStep({
    tenantId: g.tenantId,
    staffId: g.staffId,
    itemId: parsed.data.id,
  });

  revalidateClientWorkflow(clientId);
  return result;
}
