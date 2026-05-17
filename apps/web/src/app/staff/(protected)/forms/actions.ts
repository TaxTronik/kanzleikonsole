'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import type { FormFieldType, Prisma } from '@prisma/client';
import { evidenceService } from '@/server/container';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { portalBaseUrl } from '@taxtronik/config';
import { assertClientInTenant } from '@/server/db/assert-tenant';
import { toActionError } from '@/server/auth/rbac';

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

const FIELD_TYPES: FormFieldType[] = [
  'TEXT', 'TEXTAREA', 'NUMBER', 'MONEY', 'DATE', 'EMAIL', 'PHONE',
  'SELECT', 'MULTISELECT', 'CHECKBOX', 'FILE', 'INFO_TEXT',
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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  // S3: Form-Templates sind Tenant-weite Konfiguration mit FILE-Feldern
  // (Mandanten-Uploads) und werden in Workflow-Steps referenziert. Symmetrisch
  // zu Workflow-Templates (F4): ADMIN/PARTNER-only.
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = CreateSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  let id: string;
  try {
    id = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // S7: expliziter tenantId-Filter (Defense in Depth + lesbarere Intent).
        const dup = await tx.formTemplate.findFirst({ where: { tenantId, name: parsed.data.name } });
        if (dup) throw new Error('Vorlage mit diesem Namen existiert bereits.');
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
        return t.id;
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/forms');
  return { ok: true, id };
}

export async function setFormActiveAction(input: { id: string; active: boolean }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = z.object({ id: z.string().uuid(), active: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;
  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) => tx.formTemplate.update({ where: { id: parsed.data.id }, data: { active: parsed.data.active } }),
  );
  revalidatePath('/staff/forms');
  return { ok: true };
}

export async function deleteFormTemplateAction(input: { id: string }): Promise<ActionResult> {
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
        const t = await tx.formTemplate.findUnique({
          where: { id: parsed.data.id },
          include: { _count: { select: { submissions: true } } },
        });
        if (!t) throw new Error('Vorlage nicht gefunden.');
        if (t._count.submissions > 0) {
          throw new Error(`${t._count.submissions} Anfrage${t._count.submissions === 1 ? '' : 'n'} vorhanden.`);
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
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath('/staff/forms');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Felder speichern
// ----------------------------------------------------------------------------

const FieldSchema = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/),
  label: z.string().min(1).max(200),
  type: z.enum(FIELD_TYPES as [FormFieldType, ...FormFieldType[]]),
  required: z.boolean(),
  helpText: z.string().max(300).nullable(),
  defaultValue: z.string().max(500).nullable(),
  minValue: z.string().max(50).nullable(),
  maxValue: z.string().max(50).nullable(),
  options: z.array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(200) })).nullable(),
});

const SaveTemplateSchema = z.object({
  templateId: z.string().uuid(),
  description: z.string().max(500).nullable(),
  introMd: z.string().max(5000).nullable(),
  fields: z.array(FieldSchema).min(1),
});

export async function saveFormTemplateAction(input: z.infer<typeof SaveTemplateSchema>): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = SaveTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const { tenantId, staffId } = session.user;

  await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
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
  );

  revalidatePath('/staff/forms');
  revalidatePath(`/staff/forms/${parsed.data.templateId}`);
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Anfrage starten (an Mandant senden)
// ----------------------------------------------------------------------------

const CreateSubmissionSchema = z.object({
  templateId: z.string().uuid(),
  clientId: z.string().uuid(),
});

export async function createSubmissionAction(input: z.infer<typeof CreateSubmissionSchema>): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = CreateSubmissionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  let id: string;
  try {
    id = await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      async (tx) => {
        // R-2: clientId-Tenant-Sanity
        await assertClientInTenant(tx, parsed.data.clientId);
        const tpl = await tx.formTemplate.findUnique({
          where: { id: parsed.data.templateId },
          include: { _count: { select: { fields: true } } },
        });
        if (!tpl) throw new Error('Vorlage nicht gefunden.');
        if (!tpl.active) throw new Error('Vorlage ist deaktiviert.');
        if (tpl._count.fields === 0) throw new Error('Vorlage hat keine Felder.');
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
      },
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  void notifyClientContacts({
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
      bodyMd: 'Sehr geehrte/r {{contact.fullName}},\n\nin Ihrem Mandantenportal liegt ein neues Formular zum Ausfüllen bereit.\n\nBitte öffnen Sie das Portal:\n{{portalUrl}}',
    },
  });

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
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  const parsed = z
    .object({
      id: z.string().uuid(),
      notes: z.string().max(2000).optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  const { tenantId, staffId } = session.user;

  try {
    await withTenantContext(
      { tenantId, actorId: staffId, actorType: 'STAFF' },
      (tx) =>
        tx.formSubmission.update({
          where: { id: parsed.data.id },
          data: {
            status: 'REVIEWED',
            reviewedAt: new Date(),
            reviewedByStaff: staffId,
            reviewNotes: parsed.data.notes ?? null,
          },
        }),
    );
  } catch (e) {
    // R-6: Prisma-Error-Mapping (P2025 = not found / cross-tenant).
    return toActionError(e);
  }
  revalidatePath('/staff/forms');
  revalidatePath(`/staff/forms/submissions/${parsed.data.id}`);
  return { ok: true };
}
