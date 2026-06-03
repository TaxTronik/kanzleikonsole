'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { executeWorkflowStep, type ExecuteResult } from '@/server/workflows/execute-step';
import { parseStepConfig } from '@/server/workflows/step-config';
import { assertStaffInTenant } from '@/server/db/assert-tenant';
import { staffActionGuard, withStaff, ActionError, type ActionResult } from '@/server/actions/staff-action';

// Einheitliches Action-Ergebnis aus der zentralen Quelle.
export type { ActionResult };

export async function startInstanceAction(input: {
  clientId: string;
  templateId: string;
  memberIds?: string[];
}) {
  const parsed = z
    .object({
      clientId: z.string().uuid(),
      templateId: z.string().uuid(),
      memberIds: z.array(z.string().uuid()).max(50).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const tpl = await tx.workflowTemplate.findUnique({
        where: { id: parsed.data.templateId },
        include: { steps: { orderBy: { position: 'asc' } } },
      });
      if (!tpl) throw new ActionError('Vorlage nicht gefunden.');
      if (!tpl.active) throw new ActionError('Vorlage ist deaktiviert.');
      if (tpl.steps.length === 0) throw new ActionError('Vorlage hat keine Schritte.');

      const startedAt = new Date();
      const inst = await tx.workflowInstance.create({
        data: {
          tenantId,
          clientId: parsed.data.clientId,
          templateId: tpl.id,
          name: tpl.name,
          startedByStaff: staffId,
          startedAt,
          items: {
            create: tpl.steps.map((s) => ({
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
            })),
          },
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
          name: tpl.name,
          clientId: parsed.data.clientId,
          stepCount: tpl.steps.length,
          memberCount: memberSet.size,
        },
      });
    },
    { revalidate: `/staff/clients/${parsed.data.clientId}/workflows` },
  );
}

/**
 * Setzt die Mitglieder einer Workflow-Instanz neu. Macht ein Diff und legt
 * neue Member an / entfernt entfernte. Starter kann nie entfernt werden.
 */
export async function setWorkflowMembersAction(input: {
  instanceId: string;
  memberIds: string[];
}) {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      memberIds: z.array(z.string().uuid()).max(50),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
      include: { members: { select: { staffId: true } } },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');

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
        tenantId, actorType: 'STAFF', actorId: staffId,
        action: 'workflow.instance.members_update',
        resourceType: 'workflow_instance',
        resourceId: parsed.data.instanceId,
        after: { added: toAdd, removed: toRemove, total: want.size },
      });
    }
  });
  if (r.ok) revalidatePath('/staff/clients', 'layout');
  return r;
}

export async function toggleItemDoneAction(input: { id: string; done: boolean }) {
  const parsed = z.object({ id: z.string().uuid(), done: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { staffId }) => {
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
  });
  // Revalidate ohne clientId — wir kennen ihn hier nicht direkt, aber das ist ok
  // weil das Layout die nötigen Pfade refresht.
  if (r.ok) revalidatePath('/staff/clients', 'layout');
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
  const r = await withStaff(async (tx) => {
    await tx.workflowItem.update({
      where: { id: parsed.data.id },
      data: { dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null },
    });
  });
  if (r.ok) revalidatePath('/staff/clients', 'layout');
  return r;
}

export async function setItemAssigneeAction(input: {
  id: string;
  staffId: string | null;
}) {
  const parsed = z
    .object({
      id: z.string().uuid(),
      staffId: z.string().uuid().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx) => {
    // R-2: assigneeStaffId muss im aktuellen Tenant existieren (falls nicht null).
    if (parsed.data.staffId) {
      await assertStaffInTenant(tx, parsed.data.staffId);
    }
    await tx.workflowItem.update({
      where: { id: parsed.data.id },
      data: { assigneeStaffId: parsed.data.staffId },
    });
  });
  if (r.ok) revalidatePath('/staff/clients', 'layout');
  return r;
}

/**
 * Bricht eine laufende Workflow-Instanz ab. Setzt den Status auf CANCELLED
 * und schreibt den Grund in `notes`. Bereits erledigte Items bleiben
 * erhalten (Historie); offene Items werden NICHT mehr als „offen" gezählt,
 * weil die Instanz nicht mehr ACTIVE ist.
 */
export async function cancelInstanceAction(input: {
  instanceId: string;
  reason: string;
}) {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      reason: z.string().min(3).max(2000),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    if (inst.status !== 'ACTIVE' && inst.status !== 'PAUSED') {
      throw new ActionError('Workflow ist bereits abgeschlossen oder abgebrochen.');
    }

    const reasonLine = `[Abgebrochen am ${new Date().toISOString().slice(0, 16).replace('T', ' ')} von ${staffId}] ${parsed.data.reason}`;
    const merged = inst.notes ? `${inst.notes}\n\n${reasonLine}` : reasonLine;

    await tx.workflowInstance.update({
      where: { id: parsed.data.instanceId },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
        notes: merged,
      },
    });

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
  });
  if (r.ok) {
    revalidatePath('/staff/clients', 'layout');
    revalidatePath('/staff/workflows');
  }
  return r;
}

/**
 * Wiederherstellen aus dem Papierkorb: CANCELLED → ACTIVE. Notiz mit
 * Wiederherstellungs-Grund wird angehängt.
 */
export async function restoreInstanceAction(input: {
  instanceId: string;
}) {
  const parsed = z.object({ instanceId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inst = await tx.workflowInstance.findUnique({ where: { id: parsed.data.instanceId } });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    if (inst.status !== 'CANCELLED') throw new ActionError('Nur abgebrochene Workflows lassen sich wiederherstellen.');

    const line = `[Wiederhergestellt am ${new Date().toISOString().slice(0, 16).replace('T', ' ')}]`;
    await tx.workflowInstance.update({
      where: { id: parsed.data.instanceId },
      data: {
        status: 'ACTIVE',
        completedAt: null,
        notes: inst.notes ? `${inst.notes}\n\n${line}` : line,
      },
    });
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'workflow.instance.restore',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      before: { status: 'CANCELLED' },
      after: { status: 'ACTIVE' },
    });
  });
  if (r.ok) {
    revalidatePath('/staff/clients', 'layout');
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
      until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inst = await tx.workflowInstance.findUnique({ where: { id: parsed.data.instanceId } });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    if (inst.status !== 'ACTIVE') throw new ActionError('Nur aktive Workflows können pausiert werden.');

    const reasonText = (parsed.data.reason ?? '').trim();
    const until = parsed.data.until;
    const tag = `[Pausiert am ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${until ? ' bis ' + until : ''}]`;
    const reasonLine = reasonText ? `${tag} ${reasonText}` : tag;

    await tx.workflowInstance.update({
      where: { id: parsed.data.instanceId },
      data: {
        status: 'PAUSED',
        pausedUntil: until ? new Date(until) : null,
        notes: inst.notes ? `${inst.notes}\n\n${reasonLine}` : reasonLine,
      },
    });
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'workflow.instance.pause',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      after: { status: 'PAUSED', pausedUntil: until, reason: reasonText || null },
    });
  });
  if (r.ok) {
    revalidatePath('/staff/clients', 'layout');
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

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inst = await tx.workflowInstance.findUnique({ where: { id: parsed.data.instanceId } });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    if (inst.status !== 'PAUSED') throw new ActionError('Nur pausierte Workflows können fortgesetzt werden.');

    await tx.workflowInstance.update({
      where: { id: parsed.data.instanceId },
      data: { status: 'ACTIVE', pausedUntil: null },
    });
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'workflow.instance.resume',
      resourceType: 'workflow_instance',
      resourceId: inst.id,
      before: { status: 'PAUSED' },
      after: { status: 'ACTIVE' },
    });
  });
  if (r.ok) {
    revalidatePath('/staff/clients', 'layout');
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
  kind?: 'TASK' | 'DOCUMENT_UPLOAD' | 'CLIENT_REQUEST' | 'CLIENT_FORM' | 'CLIENT_EMAIL' | 'N8N_TRIGGER';
  config?: unknown;
  n8nEvent?: string | null;
  assigneeStaffId?: string | null;
}) {
  const parsed = z
    .object({
      instanceId: z.string().uuid(),
      title: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      kind: z.enum(['TASK', 'DOCUMENT_UPLOAD', 'CLIENT_REQUEST', 'CLIENT_FORM', 'CLIENT_EMAIL', 'N8N_TRIGGER']).default('TASK'),
      config: z.unknown().optional(),
      n8nEvent: z.string().max(100).nullable().optional(),
      assigneeStaffId: z.string().uuid().nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const kind = parsed.data.kind ?? 'TASK';
  const configResult = parseStepConfig(kind, parsed.data.config);
  if (!configResult.ok) return { ok: false as const, error: `Kind ${kind}: ${configResult.error}` };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
      include: { items: { orderBy: { position: 'desc' }, take: 1, select: { position: true } } },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
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
        assigneeStaffId: parsed.data.assigneeStaffId === undefined ? staffId : parsed.data.assigneeStaffId,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        kind,
        config: configResult.value as object,
        n8nEvent: parsed.data.n8nEvent?.trim() || null,
      },
    });
    await evidenceService.record(tx, {
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'workflow.item.add',
      resourceType: 'workflow_item',
      resourceId: item.id,
      after: { instanceId: parsed.data.instanceId, title: parsed.data.title, kind, adHoc: true },
    });
  });
  if (r.ok) revalidatePath('/staff/clients', 'layout');
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

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const myName = session.user.name ?? 'Ich';
    const item = await tx.workflowItem.findUnique({ where: { id: parsed.data.itemId } });
    if (!item) throw new ActionError('Schritt nicht gefunden.');
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
      tenantId, actorType: 'STAFF', actorId: staffId,
      action: 'workflow.item.handover',
      resourceType: 'workflow_item',
      resourceId: item.id,
      before: { assigneeStaffId: item.assigneeStaffId },
      after: { assigneeStaffId: parsed.data.toStaffId, note: note || null },
    });
  });
  if (r.ok) revalidatePath('/staff/clients', 'layout');
  return r;
}

/**
 * Kommentar zu einem Workflow-Item anlegen.
 */
export async function addItemCommentAction(input: {
  itemId: string;
  body: string;
}) {
  const parsed = z
    .object({
      itemId: z.string().uuid(),
      body: z.string().min(1).max(5000),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId, session }) => {
    const authorName = session.user.name ?? 'Mitarbeiter';
    const item = await tx.workflowItem.findUnique({
      where: { id: parsed.data.itemId },
      select: { id: true },
    });
    if (!item) throw new ActionError('Schritt nicht gefunden.');
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
  });
  if (r.ok) revalidatePath('/staff/clients', 'layout');
  return r;
}

/**
 * Lazy-Resume: setzt alle pausierten Instanzen, deren `pausedUntil ≤ now`,
 * automatisch auf ACTIVE. Wird beim Page-Load der Workflow-Sichten
 * aufgerufen — kein separater Worker nötig.
 *
 * Kein Server-Action im UI-Sinn: wird server-seitig aus bereits
 * autorisierten Page-Komponenten mit explizitem (tenantId, staffId) gerufen.
 */
export async function autoResumePausedWorkflows(tenantId: string, staffId: string): Promise<void> {
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const ready = await tx.workflowInstance.findMany({
        where: { status: 'PAUSED', pausedUntil: { not: null, lte: new Date() } },
        select: { id: true },
      });
      if (ready.length === 0) return;
      await tx.workflowInstance.updateMany({
        where: { id: { in: ready.map((r) => r.id) } },
        data: { status: 'ACTIVE', pausedUntil: null },
      });
      for (const r of ready) {
        await evidenceService.record(tx, {
          tenantId, actorType: 'SYSTEM', actorId: null,
          action: 'workflow.instance.auto_resume',
          resourceType: 'workflow_instance',
          resourceId: r.id,
          after: { status: 'ACTIVE' },
        });
      }
    },
  );
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
export async function deleteCancelledInstanceAction(input: {
  instanceId: string;
}) {
  const parsed = z.object({ instanceId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: 'Validierungsfehler.' };

  const r = await withStaff(async (tx, { tenantId, staffId }) => {
    const inst = await tx.workflowInstance.findUnique({
      where: { id: parsed.data.instanceId },
    });
    if (!inst) throw new ActionError('Workflow nicht gefunden.');
    if (inst.status !== 'CANCELLED') {
      throw new ActionError('Nur abgebrochene Workflows können endgültig gelöscht werden.');
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

    await tx.workflowInstance.delete({ where: { id: parsed.data.instanceId } });
  });
  if (r.ok) {
    revalidatePath('/staff/clients', 'layout');
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
export async function executeItemAction(input: { id: string }): Promise<ActionResult & ExecuteResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const result = await executeWorkflowStep({
    tenantId: g.tenantId,
    staffId: g.staffId,
    itemId: parsed.data.id,
  });

  revalidatePath('/staff/clients', 'layout');
  return result;
}
