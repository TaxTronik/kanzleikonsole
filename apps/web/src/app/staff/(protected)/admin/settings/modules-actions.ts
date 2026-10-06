'use server';

// Was die Kanzlei nutzt + wie das Mandanten-Cockpit/Portal aussieht: Modul-
// Toggles, Zugriffsmodell, Cockpit-Layout, Portal-Feature-Flags. Aus der
// früheren settings/actions.ts-God-Datei herausgelöst.

import { z } from 'zod';
import { EXPANSION_MODULES } from '@/lib/expansion-modules';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import { staffAction, type ActionResult } from '@/server/actions/staff-action';
import { audit } from '@/server/actions/audit';
import { formDefault, formFlag, parseFormData } from '@/server/actions/form-data';
import {
  writeModulesTx,
  type BooleanModuleKey,
  type ModuleConfig,
} from '@/server/settings/modules';
import { writeAccessPolicyTx, type ClientAccessMode } from '@/server/settings/access-policy';
import {
  writeClientLayoutTx,
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

const MODULE_FLAGS = [
  ...EXPANSION_MODULES.map(({ key }) => key),
  'bwa',
  'knowledge',
  'timeTracking',
  'phoneNotes',
  'taxNotices',
  'workflows',
  'forms',
  'reminders',
  'binders',
  'handovers',
  'appointments',
  'rssReader',
  'inboundMail',
  'risk',
  'signalEngine',
] as const satisfies readonly BooleanModuleKey[];
type ModuleFlag = (typeof MODULE_FLAGS)[number];

// Formularfelder heißen wie im Formular: Modul-Haken `enabled.<Modul>` (an nur
// bei „on“), PDF-Vorlagentexte fehlend → '' (R-12).
const ModulesSchema = z.object({
  ...(Object.fromEntries(MODULE_FLAGS.map((key) => [`enabled.${key}`, formFlag()])) as Record<
    `enabled.${ModuleFlag}`,
    ReturnType<typeof formFlag<z.ZodBoolean>>
  >),
  subsumtionFloatingToolbarDefault: formFlag(),
  poaMode: z.enum(['OFF', 'MARKDOWN_OTP', 'PDF_TEMPLATE']),
  poaPdfSubject: formDefault('', z.string().max(200).optional()),
  poaPdfBodyMd: formDefault('', z.string().max(5000).optional()),
  invoiceMode: z.enum(['OFF', 'IN_APP', 'EXTERNAL']),
  invoicePdfSubject: formDefault('', z.string().max(200).optional()),
  invoicePdfBodyMd: formDefault('', z.string().max(5000).optional()),
});

export async function saveModulesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(ModulesSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const { ctx } = g;
      const enabled = (key: ModuleFlag): boolean => parsed.data[`enabled.${key}`];
      const cfg: ModuleConfig = {
        knowledgeContext: enabled('knowledgeContext'),
        yearEndCampaigns: enabled('yearEndCampaigns'),
        noticeDecisions: enabled('noticeDecisions'),
        smartMailbox: enabled('smartMailbox'),
        payrollIntake: enabled('payrollIntake'),
        expenseAssistance: enabled('expenseAssistance'),
        clientProcedures: enabled('clientProcedures'),
        feedbackSurveys: enabled('feedbackSurveys'),
        mandateStructure: enabled('mandateStructure'),
        workflowDependencies: enabled('workflowDependencies'),
        mandateOffboarding: enabled('mandateOffboarding'),
        vdbPreparation: enabled('vdbPreparation'),
        sanctionsScreening: enabled('sanctionsScreening'),
        feeCalculator: enabled('feeCalculator'),
        bwa: enabled('bwa'),
        knowledge: enabled('knowledge'),
        timeTracking: enabled('timeTracking'),
        phoneNotes: enabled('phoneNotes'),
        taxNotices: enabled('taxNotices'),
        workflows: enabled('workflows'),
        forms: enabled('forms'),
        reminders: enabled('reminders'),
        binders: enabled('binders'),
        handovers: enabled('handovers'),
        appointments: enabled('appointments'),
        rssReader: enabled('rssReader'),
        inboundMail: enabled('inboundMail'),
        risk: enabled('risk'),
        signalEngine: enabled('signalEngine'),
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

      await withTenantContext(ctx, async (tx) => {
        await writeModulesTx(tx, ctx, cfg);
        await audit(tx, g, {
          action: 'tenant.settings.modules.update',
          resourceType: 'tenant_setting',
          resourceId: 'modules',
          after: cfg,
        });
      });

      revalidatePath('/staff/admin/settings');
      revalidatePath('/staff', 'layout');
    },
  });
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
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(AccessPolicySchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const { ctx } = g;
      const cfg = { clientAccessMode: parsed.data.clientAccessMode as ClientAccessMode };
      await withTenantContext(ctx, async (tx) => {
        await writeAccessPolicyTx(tx, ctx, cfg);
        await audit(tx, g, {
          action: 'tenant.settings.access_policy.update',
          resourceType: 'tenant_setting',
          resourceId: 'access',
          after: cfg,
        });
      });
    },
    revalidate: '/staff/admin/settings/modules',
  });
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
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = ClientLayoutSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

      const { ctx } = g;
      await withTenantContext(ctx, async (tx) => {
        await writeClientLayoutTx(tx, ctx, { items: parsed.data.items });
        await audit(tx, g, {
          action: 'tenant.settings.client_layout.update',
          resourceType: 'tenant_setting',
          resourceId: 'client_detail.layout',
          after: { itemCount: parsed.data.items.length },
        });
      });
      revalidatePath('/staff/admin/settings/modules');
      revalidatePath('/staff/clients', 'layout');
    },
  });
}

export async function resetClientLayoutAction(): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const { ctx } = g;
      await withTenantContext(ctx, async (tx) => {
        await writeClientLayoutTx(tx, ctx, DEFAULT_CLIENT_LAYOUT);
        await audit(tx, g, {
          action: 'tenant.settings.client_layout.update',
          resourceType: 'tenant_setting',
          resourceId: 'client_detail.layout',
          after: { reset: true },
        });
      });
      revalidatePath('/staff/admin/settings/modules');
      revalidatePath('/staff/clients', 'layout');
    },
  });
}

// ----------------------------------------------------------------------------
// Mandantenportal-Feature-Flags
// ----------------------------------------------------------------------------

const PortalFeaturesSchema = z.object({
  appointmentRequests: formFlag(),
  bwaView: formFlag(),
  bwaPlanning: formFlag(),
  documentUpload: formFlag(),
  clientInbox: formFlag(),
  stammdatenSelfService: formFlag(),
  handoversView: formFlag(),
  // Wie bisher Number(…): fehlend → 365, leer → 0 (abgelehnt), Text → NaN (abgelehnt).
  messageRetentionDays: z.preprocess(
    (value) => Number(value ?? 365),
    z.number().int().min(30).max(3650),
  ),
  retentionDocumented: formFlag(),
});

export async function savePortalFeaturesAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(PortalFeaturesSchema, formData, { absentAsNull: true });
      if (!parsed.ok) return parsed;
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
        await audit(tx, g, {
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
    },
  });
}
