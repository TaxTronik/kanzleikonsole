'use server';

// Was die Kanzlei nutzt + wie das Mandanten-Cockpit/Portal aussieht: Modul-
// Toggles, Zugriffsmodell, Cockpit-Layout, Portal-Feature-Flags. Aus der
// früheren settings/actions.ts-God-Datei herausgelöst.

import { z } from 'zod';
import { EXPANSION_MODULES } from '@/lib/expansion-modules';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { writeModules, type ModuleConfig } from '@/server/settings/modules';
import { writeAccessPolicy, type ClientAccessMode } from '@/server/settings/access-policy';
import {
  writeClientLayout,
  ALL_CLIENT_BLOCKS,
  DEFAULT_CLIENT_LAYOUT,
  type ClientBlockKey,
  type ClientGridItem,
} from '@/server/settings/client-layout';
import { writePortalFeaturesTx, type PortalFeatures } from '@/server/settings/portal-features';
import { writePortalInboxRetentionTx } from '@/server/inbox/retention-settings';

// ----------------------------------------------------------------------------
// Module + Vollmachten-Modus
// ----------------------------------------------------------------------------

const ModulesSchema = z.object({
  ...Object.fromEntries(EXPANSION_MODULES.map(({ key }) => [key, z.boolean()])),
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
  signalEngine: z.boolean(),
  subsumtionFloatingToolbarDefault: z.boolean(),
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
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;

  const parsed = ModulesSchema.safeParse({
    ...Object.fromEntries(
      EXPANSION_MODULES.map(({ key }) => [key, formData.get(`enabled.${key}`) === 'on']),
    ),
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
    signalEngine: formData.get('enabled.signalEngine') === 'on',
    subsumtionFloatingToolbarDefault: formData.get('subsumtionFloatingToolbarDefault') === 'on',
    poaMode: formData.get('poaMode'),
    poaPdfSubject: formData.get('poaPdfSubject') ?? '',
    poaPdfBodyMd: formData.get('poaPdfBodyMd') ?? '',
    invoiceMode: formData.get('invoiceMode'),
    invoicePdfSubject: formData.get('invoicePdfSubject') ?? '',
    invoicePdfBodyMd: formData.get('invoicePdfBodyMd') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId, ctx } = g;
  const cfg: ModuleConfig = {
    knowledgeContext: formData.get('enabled.knowledgeContext') === 'on',
    yearEndCampaigns: formData.get('enabled.yearEndCampaigns') === 'on',
    noticeDecisions: formData.get('enabled.noticeDecisions') === 'on',
    smartMailbox: formData.get('enabled.smartMailbox') === 'on',
    payrollIntake: formData.get('enabled.payrollIntake') === 'on',
    expenseAssistance: formData.get('enabled.expenseAssistance') === 'on',
    clientProcedures: formData.get('enabled.clientProcedures') === 'on',
    feedbackSurveys: formData.get('enabled.feedbackSurveys') === 'on',
    mandateStructure: formData.get('enabled.mandateStructure') === 'on',
    workflowDependencies: formData.get('enabled.workflowDependencies') === 'on',
    mandateOffboarding: formData.get('enabled.mandateOffboarding') === 'on',
    vdbPreparation: formData.get('enabled.vdbPreparation') === 'on',
    sanctionsScreening: formData.get('enabled.sanctionsScreening') === 'on',
    feeCalculator: formData.get('enabled.feeCalculator') === 'on',
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
    signalEngine: parsed.data.signalEngine,
    subsumtionFloatingToolbarDefault: parsed.data.subsumtionFloatingToolbarDefault,
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
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;

  const parsed = AccessPolicySchema.safeParse({
    clientAccessMode: formData.get('clientAccessMode'),
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId, ctx } = g;
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
  items: z
    .array(
      z.object({
        id: BlockKeyEnum,
        x: z.number().int().min(0).max(11),
        y: z.number().int().min(0).max(200),
        w: z.number().int().min(2).max(12),
        h: z.number().int().min(2).max(40),
      }),
    )
    .min(1)
    .max(20),
});

export async function saveClientLayoutAction(input: {
  items: ClientGridItem[];
}): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const parsed = ClientLayoutSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const { tenantId, staffId, ctx } = g;
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
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const { tenantId, staffId, ctx } = g;
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
  clientInbox: z.boolean(),
  stammdatenSelfService: z.boolean(),
  handoversView: z.boolean(),
  messageRetentionDays: z.number().int().min(30).max(3650),
  retentionDocumented: z.boolean(),
});

export async function savePortalFeaturesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const parsed = PortalFeaturesSchema.safeParse({
    appointmentRequests: formData.get('appointmentRequests') === 'on',
    bwaView: formData.get('bwaView') === 'on',
    bwaPlanning: formData.get('bwaPlanning') === 'on',
    documentUpload: formData.get('documentUpload') === 'on',
    clientInbox: formData.get('clientInbox') === 'on',
    stammdatenSelfService: formData.get('stammdatenSelfService') === 'on',
    handoversView: formData.get('handoversView') === 'on',
    messageRetentionDays: Number(formData.get('messageRetentionDays') ?? 365),
    retentionDocumented: formData.get('retentionDocumented') === 'on',
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([key, messages]) => [
          key,
          messages,
        ]),
      ),
    };
  }
  if (parsed.data.clientInbox && !parsed.data.retentionDocumented) {
    return {
      ok: false,
      error:
        'Vor der Aktivierung muss die organisatorische Nachrichtenretention dokumentiert sein.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: {
        retentionDocumented: [
          'Bestätigen Sie die dokumentierte organisatorische Retention oder lassen Sie das Nachrichtenfach deaktiviert.',
        ],
      },
    };
  }

  const { tenantId, staffId, ctx } = g;
  const { messageRetentionDays, retentionDocumented, ...portalFeatureData } = parsed.data;
  const cfg: PortalFeatures = portalFeatureData;
  await withTenantContext(ctx, async (tx) => {
    // Flag, organisatorischer Retention-Nachweis und Audit bilden eine
    // Transaktion. So kann ein Teilfehler kein weiterhin aktives Inbox-Flag
    // mit gleichzeitig zurückgenommener Dokumentation hinterlassen.
    await writePortalInboxRetentionTx(tx, tenantId, staffId, {
      messageRetentionDays,
      organizationallyDocumented: retentionDocumented,
    });
    await writePortalFeaturesTx(tx, tenantId, staffId, cfg);
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.portal_features.update',
      resourceType: 'tenant_setting',
      resourceId: 'portal.features',
      after: {
        ...cfg,
        inboxRetentionConfigured: retentionDocumented,
        inboxMessageRetentionDays: messageRetentionDays,
      },
    });
  });
  revalidatePath('/staff/admin/settings/portal');
  revalidatePath('/portal', 'layout');
  return { ok: true };
}
