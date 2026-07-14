'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import type { FormFieldType, Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { fireAndForget } from '@/server/util/fire-and-forget';
import { portalBaseUrl } from '@taxtronik/config';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { toActionError, assertClientAccessTx } from '@/server/auth/rbac';
import {
  staffActionGuard,
  withStaff,
  ActionError,
  type ActionResult as BaseActionResult,
} from '@/server/actions/staff-action';

export interface ActionResult extends BaseActionResult {
  id?: string;
}

const FIELD_TYPES: FormFieldType[] = [
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'MONEY',
  'DATE',
  'EMAIL',
  'PHONE',
  'SELECT',
  'MULTISELECT',
  'CHECKBOX',
  'FILE',
  'INFO_TEXT',
];

// ----------------------------------------------------------------------------
// Vorlagen-Verwaltung
// ----------------------------------------------------------------------------

const CreateSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
});

export async function createFormTemplateAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = CreateSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // S3: Form-Templates sind Tenant-weite Konfiguration mit FILE-Feldern
  // (Mandanten-Uploads) und werden in Workflow-Steps referenziert. Symmetrisch
  // zu Workflow-Templates (F4): ADMIN/PARTNER-only.
  return withStaff(
    async (tx, { tenantId, staffId }) => {
      // S7: expliziter tenantId-Filter (Defense in Depth + lesbarere Intent).
      const dup = await tx.formTemplate.findFirst({ where: { tenantId, name: parsed.data.name } });
      if (dup) throw new ActionError('Vorlage mit diesem Namen existiert bereits.');
      const t = await tx.formTemplate.create({
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
        action: 'form.template.create',
        resourceType: 'form_template',
        resourceId: t.id,
        after: { name: t.name },
      });
      return { id: t.id };
    },
    { requireAdmin: true, revalidate: '/staff/forms' },
  );
}

export async function setFormActiveAction(input: {
  id: string;
  active: boolean;
}): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid(), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx) => {
      await tx.formTemplate.update({
        where: { id: parsed.data.id },
        data: { active: parsed.data.active },
      });
    },
    { requireAdmin: true, revalidate: '/staff/forms' },
  );
}

export async function deleteFormTemplateAction(input: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      const t = await tx.formTemplate.findUnique({
        where: { id: parsed.data.id },
        include: { _count: { select: { submissions: true } } },
      });
      if (!t) throw new ActionError('Vorlage nicht gefunden.');
      if (t._count.submissions > 0) {
        throw new ActionError(
          `${t._count.submissions} Anfrage${t._count.submissions === 1 ? '' : 'n'} vorhanden.`,
        );
      }
      await tx.formTemplate.delete({ where: { id: parsed.data.id } });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'form.template.delete',
        resourceType: 'form_template',
        resourceId: parsed.data.id,
        before: { name: t.name },
      });
    },
    { requireAdmin: true, revalidate: '/staff/forms' },
  );
}

// ----------------------------------------------------------------------------
// Felder speichern
// ----------------------------------------------------------------------------

const FieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_]+$/),
  label: z.string().min(1).max(200),
  type: z.enum(FIELD_TYPES as [FormFieldType, ...FormFieldType[]]),
  required: z.boolean(),
  helpText: z.string().max(300).nullable(),
  defaultValue: z.string().max(500).nullable(),
  minValue: z.string().max(50).nullable(),
  maxValue: z.string().max(50).nullable(),
  options: z
    .array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(200) }))
    .nullable(),
});

const SaveTemplateSchema = z.object({
  templateId: z.string().uuid(),
  description: z.string().max(500).nullable(),
  introMd: z.string().max(5000).nullable(),
  fields: z.array(FieldSchema).min(1),
});

export async function saveFormTemplateAction(
  input: z.infer<typeof SaveTemplateSchema>,
): Promise<ActionResult> {
  const parsed = SaveTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }

  return withStaff(
    async (tx, { tenantId, staffId }) => {
      await tx.formTemplate.update({
        where: { id: parsed.data.templateId },
        data: {
          description: parsed.data.description,
          introMd: parsed.data.introMd,
        },
      });
      await tx.formField.deleteMany({ where: { templateId: parsed.data.templateId } });
      for (let i = 0; i < parsed.data.fields.length; i++) {
        const f = parsed.data.fields[i]!;
        await tx.formField.create({
          data: {
            templateId: parsed.data.templateId,
            position: i,
            key: f.key,
            label: f.label,
            type: f.type,
            required: f.required,
            helpText: f.helpText,
            defaultValue: f.defaultValue,
            minValue: f.minValue,
            maxValue: f.maxValue,
            options: f.options as Prisma.InputJsonValue | undefined,
          },
        });
      }
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'form.template.update',
        resourceType: 'form_template',
        resourceId: parsed.data.templateId,
        after: { fieldCount: parsed.data.fields.length },
      });
    },
    { requireAdmin: true, revalidate: ['/staff/forms', `/staff/forms/${parsed.data.templateId}`] },
  );
}

// ----------------------------------------------------------------------------
// Anfrage starten (an Mandant senden)
// ----------------------------------------------------------------------------

const CreateSubmissionSchema = z.object({
  templateId: z.string().uuid(),
  clientId: z.string().uuid(),
});

export async function createSubmissionAction(
  input: z.infer<typeof CreateSubmissionSchema>,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;

  const parsed = CreateSubmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  let id: string;
  try {
    id = await withTenantContext(ctx, async (tx) => {
      // R-2: clientId-Tenant-Sanity + Vertraulich-/RESTRICTED-Ventil
      await assertClientInTenant(tx, parsed.data.clientId);
      await assertClientAccessTx(tx, g.session, parsed.data.clientId);
      const tpl = await tx.formTemplate.findUnique({
        where: { id: parsed.data.templateId },
        include: { _count: { select: { fields: true } } },
      });
      if (!tpl) throw new ActionError('Vorlage nicht gefunden.');
      if (!tpl.active) throw new ActionError('Vorlage ist deaktiviert.');
      if (tpl._count.fields === 0) throw new ActionError('Vorlage hat keine Felder.');
      const sub = await tx.formSubmission.create({
        data: {
          tenantId,
          templateId: tpl.id,
          clientId: parsed.data.clientId,
          name: tpl.name,
          createdByStaff: staffId,
        },
      });
      await evidenceService.record(tx, {
        tenantId,
        actorType: 'STAFF',
        actorId: staffId,
        action: 'form.submission.create',
        resourceType: 'form_submission',
        resourceId: sub.id,
        after: { templateName: tpl.name, clientId: parsed.data.clientId },
      });
      return sub.id;
    });
  } catch (e) {
    return toActionError(e);
  }

  // Befund 3: fire-and-forget mit catch+Log statt `void` (unhandled rejection).
  fireAndForget(
    'notifyClientContacts (form-sent)',
    notifyClientContacts({
      tenantId,
      clientId: parsed.data.clientId,
      slug: 'request-opened',
      vars: {
        request: { id, title: 'Neues Formular zum Ausfüllen', description: '' },
        portalUrl: `${portalBaseUrl}/portal/forms/${id}`,
      },
      n8nEvent: 'request.opened',
      n8nPayload: {
        tenantId,
        formSubmissionId: id,
        clientId: parsed.data.clientId,
      },
      fallback: {
        subject: 'Neues Formular von Ihrer Kanzlei',
        bodyMd:
          'Sehr geehrte/r {{contact.fullName}},\n\nin Ihrem Mandantenportal liegt ein neues Formular zum Ausfüllen bereit.\n\nBitte öffnen Sie das Portal:\n{{portalUrl}}',
      },
    }),
  );

  revalidatePath(`/staff/clients/${parsed.data.clientId}`);
  revalidatePath('/staff/forms');
  return { ok: true, id };
}

// ----------------------------------------------------------------------------
// Review (Staff markiert Submission als geprüft)
// ----------------------------------------------------------------------------

export async function reviewSubmissionAction(input: {
  id: string;
  notes?: string;
}): Promise<ActionResult> {
  const parsed = z
    .object({
      id: z.string().uuid(),
      notes: z.string().max(2000).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  // R-6: Prisma-Error-Mapping (P2025 = not found / cross-tenant) via withStaff.
  return withStaff(
    async (tx, { session, staffId }) => {
      // Vertraulich-/RESTRICTED-Ventil: Submission zuerst inkl. clientId lesen.
      const sub = await tx.formSubmission.findUnique({
        where: { id: parsed.data.id },
        select: { clientId: true },
      });
      if (!sub) throw new ActionError('Formular nicht gefunden.');
      await assertClientAccessTx(tx, session, sub.clientId);
      await tx.formSubmission.update({
        where: { id: parsed.data.id },
        data: {
          status: 'REVIEWED',
          reviewedAt: new Date(),
          reviewedByStaff: staffId,
          reviewNotes: parsed.data.notes ?? null,
        },
      });
    },
    { revalidate: ['/staff/forms', `/staff/forms/submissions/${parsed.data.id}`] },
  );
}
