'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { evidenceService } from '@/server/container';
import { parseStepConfig } from '@/server/workflows/step-config';
import { startInstanceAction } from '../clients/[id]/workflows/actions';
import { withStaff, ActionError, type ActionResult as BaseActionResult } from '@/server/actions/staff-action';

export interface ActionResult extends BaseActionResult {
  id?: string;
}

const CreateSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
});

export async function createTemplateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = CreateSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // F4: Workflow-Templates sind Tenant-weite Konfiguration (n8n-Events,
  // CLIENT_EMAIL/REQUEST/FORM-Steps). Konsistent zu email-templates,
  // request-templates, state-machines etc. — ADMIN/PARTNER-only.
  return withStaff(
    async (tx, { tenantId, staffId }) => {
      // S7: expliziter tenantId-Filter zusätzlich zur RLS — Defense in Depth
      // und liest sich klarer als „RLS macht den Rest".
      const dup = await tx.workflowTemplate.findFirst({ where: { tenantId, name: parsed.data.name } });
      if (dup) throw new ActionError('Vorlage mit diesem Namen existiert bereits.');
      const t = await tx.workflowTemplate.create({
        data: {
          tenantId,
          name: parsed.data.name,
          description: parsed.data.description?.trim() || null,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'workflow.template.create',
        resourceType: 'workflow_template',
        resourceId: t.id,
        after: { name: t.name },
      });
      return { id: t.id };
    },
    { requireAdmin: true, revalidate: '/staff/workflows/templates' },
  );
}

export async function setTemplateActiveAction(input: { id: string; active: boolean }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid(), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx) => {
      await tx.workflowTemplate.update({ where: { id: parsed.data.id }, data: { active: parsed.data.active } });
    },
    { requireAdmin: true, revalidate: '/staff/workflows/templates' },
  );
}

export async function deleteTemplateAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const tpl = await tx.workflowTemplate.findUnique({
        where: { id: parsed.data.id },
        include: { _count: { select: { instances: true } } },
      });
      if (!tpl) throw new ActionError('Vorlage nicht gefunden.');
      if (tpl._count.instances > 0) {
        throw new ActionError(
          `Vorlage hat ${tpl._count.instances} Instanz${tpl._count.instances === 1 ? '' : 'en'} (laufend oder abgeschlossen). Bitte stattdessen deaktivieren.`,
        );
      }
      // Schritte werden via onDelete: Cascade mitgelöscht.
      await tx.workflowTemplate.delete({ where: { id: parsed.data.id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'workflow.template.delete',
        resourceType: 'workflow_template',
        resourceId: parsed.data.id,
        before: { name: tpl.name },
      });
    },
    { requireAdmin: true, revalidate: '/staff/workflows/templates' },
  );
}

// ----------------------------------------------------------------------------
// Step-Verwaltung (vom Detail-Editor aufgerufen)
// ----------------------------------------------------------------------------

const StepKindSchema = z.enum([
  'TASK', 'DOCUMENT_UPLOAD', 'CLIENT_REQUEST', 'CLIENT_FORM', 'CLIENT_EMAIL', 'N8N_TRIGGER',
]);

const SaveStepsSchema = z.object({
  templateId: z.string().uuid(),
  description: z.string().max(500).nullable(),
  defaultSkillId: z.string().uuid().nullable(),
  steps: z.array(
    z.object({
      title: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      dueAfterDays: z.number().int().min(0).max(365).nullable(),
      skillId: z.string().uuid().nullable(),
      kind: StepKindSchema.default('TASK'),
      config: z.unknown().optional(),
      // F8: strikte Validierung. Wird via emitN8nEvent als URL-Path-Segment
      // an n8n geschickt — `?`, `#`, `/` würden die URL-Semantik ändern
      // (Query, Fragment, Path-Traversal).
      // L-7: zusätzlich kein Punkt erlaubt — sonst entstehen Sub-Hierarchien
      // wie `workflow.step.foo.bar.baz`, die in n8n als verschachtelte
      // Path-Segment-Trigger missrouten könnten. Erlaubt: lowercase + digits + _ -
      n8nEvent: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,40}$/, 'Nur Kleinbuchstaben, Ziffern, _- erlaubt (Start: Buchstabe, max. 41 Zeichen)')
        .nullable()
        .optional(),
    }),
  ).min(1),
});

export async function saveTemplateAction(input: z.infer<typeof SaveStepsSchema>): Promise<ActionResult> {
  const parsed = SaveStepsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const r = await withStaff(
    async (tx, { tenantId, staffId }) => {
      await tx.workflowTemplate.update({
        where: { id: parsed.data.templateId },
        data: {
          description: parsed.data.description,
          defaultSkillId: parsed.data.defaultSkillId,
        },
      });
      // Steps komplett neu schreiben — einfacher als Diff
      await tx.workflowStep.deleteMany({ where: { templateId: parsed.data.templateId } });
      for (let i = 0; i < parsed.data.steps.length; i++) {
        const s = parsed.data.steps[i]!;
        const kind = s.kind ?? 'TASK';
        const configResult = parseStepConfig(kind, s.config);
        if (!configResult.ok) {
          throw new ActionError(`Schritt „${s.title}" (${kind}): ${configResult.error}`);
        }
        await tx.workflowStep.create({
          data: {
            templateId: parsed.data.templateId,
            position: i,
            title: s.title,
            description: s.description?.trim() || null,
            dueAfterDays: s.dueAfterDays,
            skillId: s.skillId,
            kind,
            config: configResult.value as object,
            n8nEvent: (s.n8nEvent ?? '').trim() || null,
          },
        });
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'workflow.template.update',
        resourceType: 'workflow_template',
        resourceId: parsed.data.templateId,
        after: { stepCount: parsed.data.steps.length },
      });
    },
    { requireAdmin: true, revalidate: '/staff/workflows/templates' },
  );
  if (r.ok) revalidatePath(`/staff/workflows/templates/${parsed.data.templateId}`);
  return r;
}

// ----------------------------------------------------------------------------
// Quick-Start: Workflow direkt aus der Vorlagen-Liste für einen Mandanten starten
// ----------------------------------------------------------------------------

export async function quickStartWorkflowAction(input: {
  templateId: string;
  clientId: string;
}): Promise<ActionResult & { redirectTo?: string }> {
  const r = await startInstanceAction(input);
  if (!r.ok) return r;
  return { ok: true, redirectTo: `/staff/clients/${input.clientId}/workflows` };
}
