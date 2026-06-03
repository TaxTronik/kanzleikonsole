'use server';

// Was die Kanzlei nutzt + wie das Mandanten-Cockpit/Portal aussieht: Modul-
// Toggles, Zugriffsmodell, Cockpit-Layout, Portal-Feature-Flags. Aus der
// früheren settings/actions.ts-God-Datei herausgelöst.

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { writeModules, type ModuleConfig } from '@/server/settings/modules';
import { writeAccessPolicy, type ClientAccessMode } from '@/server/settings/access-policy';
import { writeClientLayout, ALL_CLIENT_BLOCKS, DEFAULT_CLIENT_LAYOUT, type ClientBlockKey, type ClientGridItem } from '@/server/settings/client-layout';
import { writePortalFeatures, type PortalFeatures } from '@/server/settings/portal-features';
import type { ActionResult } from '@/server/actions/staff-action';

// ----------------------------------------------------------------------------
// Module + Vollmachten-Modus
// ----------------------------------------------------------------------------

const ModulesSchema = z.object({
  bwa: z.boolean(),
  knowledge: z.boolean(),
  timeTracking: z.boolean(),
  phoneNotes: z.boolean(),
  taxNotices: z.boolean(),
  workflows: z.boolean(),
  forms: z.boolean(),
  reminders: z.boolean(),
  binders: z.boolean(),
  handovers: z.boolean(),
  appointments: z.boolean(),
  rssReader: z.boolean(),
  inboundMail: z.boolean(),
  risk: z.boolean(),
  poaMode: z.enum(['OFF', 'MARKDOWN_OTP', 'PDF_TEMPLATE']),
  poaPdfSubject: z.string().max(200).optional(),
  poaPdfBodyMd: z.string().max(5000).optional(),
  invoiceMode: z.enum(['OFF', 'IN_APP', 'EXTERNAL']),
  invoicePdfSubject: z.string().max(200).optional(),
  invoicePdfBodyMd: z.string().max(5000).optional(),
});

export async function saveModulesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = ModulesSchema.safeParse({
    bwa: formData.get('enabled.bwa') === 'on',
    knowledge: formData.get('enabled.knowledge') === 'on',
    timeTracking: formData.get('enabled.timeTracking') === 'on',
    phoneNotes: formData.get('enabled.phoneNotes') === 'on',
    taxNotices: formData.get('enabled.taxNotices') === 'on',
    workflows: formData.get('enabled.workflows') === 'on',
    forms: formData.get('enabled.forms') === 'on',
    reminders: formData.get('enabled.reminders') === 'on',
    binders: formData.get('enabled.binders') === 'on',
    handovers: formData.get('enabled.handovers') === 'on',
    appointments: formData.get('enabled.appointments') === 'on',
    rssReader: formData.get('enabled.rssReader') === 'on',
    inboundMail: formData.get('enabled.inboundMail') === 'on',
    risk: formData.get('enabled.risk') === 'on',
    poaMode: formData.get('poaMode'),
    poaPdfSubject: formData.get('poaPdfSubject') ?? '',
    poaPdfBodyMd: formData.get('poaPdfBodyMd') ?? '',
    invoiceMode: formData.get('invoiceMode'),
    invoicePdfSubject: formData.get('invoicePdfSubject') ?? '',
    invoicePdfBodyMd: formData.get('invoicePdfBodyMd') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg: ModuleConfig = {
    bwa: parsed.data.bwa,
    knowledge: parsed.data.knowledge,
    timeTracking: parsed.data.timeTracking,
    phoneNotes: parsed.data.phoneNotes,
    taxNotices: parsed.data.taxNotices,
    workflows: parsed.data.workflows,
    forms: parsed.data.forms,
    reminders: parsed.data.reminders,
    binders: parsed.data.binders,
    handovers: parsed.data.handovers,
    appointments: parsed.data.appointments,
    rssReader: parsed.data.rssReader,
    inboundMail: parsed.data.inboundMail,
    risk: parsed.data.risk,
    poaMode: parsed.data.poaMode,
    poaPdfTemplate:
      parsed.data.poaMode === 'PDF_TEMPLATE'
        ? {
            subject: (parsed.data.poaPdfSubject ?? '').trim() || 'Vollmacht zur Unterzeichnung',
            bodyMd: (parsed.data.poaPdfBodyMd ?? '').trim(),
          }
        : null,
    invoiceMode: parsed.data.invoiceMode,
    invoicePdfTemplate:
      parsed.data.invoiceMode === 'EXTERNAL'
        ? {
            subject: (parsed.data.invoicePdfSubject ?? '').trim() || 'Ihre Rechnung',
            bodyMd: (parsed.data.invoicePdfBodyMd ?? '').trim(),
          }
        : null,
  };

  await writeModules(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.modules.update',
      resourceType: 'tenant_setting',
      resourceId: 'modules',
      after: cfg,
    });
  });

  revalidatePath('/staff/admin/settings');
  revalidatePath('/staff', 'layout');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Zugriffsmodell (OPEN / RESTRICTED) — wie weit Mitarbeiter mandantenübergreifend arbeiten
// ----------------------------------------------------------------------------

const AccessPolicySchema = z.object({
  clientAccessMode: z.enum(['OPEN', 'RESTRICTED']),
});

export async function saveAccessPolicyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };

  const parsed = AccessPolicySchema.safeParse({ clientAccessMode: formData.get('clientAccessMode') });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg = { clientAccessMode: parsed.data.clientAccessMode as ClientAccessMode };
  await writeAccessPolicy(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.access_policy.update',
      resourceType: 'tenant_setting',
      resourceId: 'access',
      after: cfg,
    });
  });

  revalidatePath('/staff/admin/settings/modules');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Mandanten-Cockpit-Layout (12-Spalten-Grid analog Dashboard, aber Tenant-global)
// ----------------------------------------------------------------------------

const BlockKeyEnum = z.enum(ALL_CLIENT_BLOCKS as [ClientBlockKey, ...ClientBlockKey[]]);

const ClientLayoutSchema = z.object({
  items: z.array(
    z.object({
      id: BlockKeyEnum,
      x: z.number().int().min(0).max(11),
      y: z.number().int().min(0).max(200),
      w: z.number().int().min(2).max(12),
      h: z.number().int().min(2).max(40),
    }),
  ).min(1).max(20),
});

export async function saveClientLayoutAction(input: { items: ClientGridItem[] }): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = ClientLayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await writeClientLayout(ctx, { items: parsed.data.items });

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.client_layout.update',
      resourceType: 'tenant_setting',
      resourceId: 'client_detail.layout',
      after: { itemCount: parsed.data.items.length },
    });
  });
  revalidatePath('/staff/admin/settings/modules');
  revalidatePath('/staff/clients', 'layout');
  return { ok: true };
}

export async function resetClientLayoutAction(): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  await writeClientLayout(ctx, DEFAULT_CLIENT_LAYOUT);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.client_layout.update',
      resourceType: 'tenant_setting',
      resourceId: 'client_detail.layout',
      after: { reset: true },
    });
  });
  revalidatePath('/staff/admin/settings/modules');
  revalidatePath('/staff/clients', 'layout');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Mandantenportal-Feature-Flags
// ----------------------------------------------------------------------------

const PortalFeaturesSchema = z.object({
  appointmentRequests: z.boolean(),
  bwaView: z.boolean(),
  bwaPlanning: z.boolean(),
  documentUpload: z.boolean(),
  stammdatenSelfService: z.boolean(),
  handoversView: z.boolean(),
});

export async function savePortalFeaturesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const session = await staffAuth();
  if (!session?.user) return { ok: false, error: 'Nicht eingeloggt.' };
  if (!isStaffAdmin(session)) return { ok: false, error: 'Nur ADMIN/PARTNER.' };
  const parsed = PortalFeaturesSchema.safeParse({
    appointmentRequests: formData.get('appointmentRequests') === 'on',
    bwaView: formData.get('bwaView') === 'on',
    bwaPlanning: formData.get('bwaPlanning') === 'on',
    documentUpload: formData.get('documentUpload') === 'on',
    stammdatenSelfService: formData.get('stammdatenSelfService') === 'on',
    handoversView: formData.get('handoversView') === 'on',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const cfg: PortalFeatures = parsed.data;
  await writePortalFeatures(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.portal_features.update',
      resourceType: 'tenant_setting',
      resourceId: 'portal.features',
      after: cfg,
    });
  });
  revalidatePath('/staff/admin/settings/portal');
  revalidatePath('/portal', 'layout');
  return { ok: true };
}
