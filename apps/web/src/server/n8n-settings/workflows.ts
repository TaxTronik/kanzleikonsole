// =============================================================================
// n8n-Einstellungen: Workflows auflisten und gebündelte Vorlagen importieren
// (Review-Finding K-03).
//
// Der Import legt nur fehlende Vorlagen an und aktiviert keinen Workflow.
// Ein dabei vorbereiteter Rückkanal-Zugang wird genau einmal zurückgegeben.
// =============================================================================

import { env } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { evidenceService } from '@/server/container';
import {
  BUNDLED_N8N_WORKFLOWS,
  bindN8nHeaderCredential,
  DEFAULT_GWG_OFFICER_EMAIL,
  materializeBundledN8nWorkflow,
  unresolvedBundledN8nPlaceholders,
  type BundledN8nWorkflow,
  type BundledN8nWorkflowValues,
} from '@/server/n8n/bundled-workflows';
import {
  prepareN8nCallbackImport,
  type N8nCallbackCredentialDisplay,
} from '@/server/n8n/callback-import-setup';
import { N8nApiClient, type N8nCredentialBinding } from '@/server/n8n/client';
import { defaultN8nCallbackBase, readN8nConfig, type N8nConfig } from '@/server/settings/n8n';
import { readSmtpConfig } from '@/server/settings/smtp';
import { WorkflowImportSchema } from './validation';
import { n8nAdminErrorMessage, revalidateN8nSettings, type N8nAdminContext } from './shared';
import type { N8nSettingsResult } from './shared';

/** Workflow der n8n-Instanz, wie ihn die Einstellungsseite listet. */
export interface N8nWorkflowRow {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string;
}

/** Import-Ergebnis mit dem ggf. einmalig angezeigten Rückkanal-Zugang. */
export interface N8nWorkflowImportResult extends N8nSettingsResult {
  credential?: N8nCallbackCredentialDisplay;
  callbackConfigured?: boolean;
}

async function recordEvidence(
  ctx: N8nAdminContext,
  action: string,
  resourceId: string,
  after: Record<string, unknown> | null,
  resourceType = 'n8n_connection',
) {
  await withTenantContext(ctx, (tx) =>
    evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action,
      resourceType,
      resourceId,
      after,
    }),
  );
}

function bundledWorkflowName(template: BundledN8nWorkflow): string {
  return typeof template.workflow['name'] === 'string' ? template.workflow['name'] : template.name;
}

async function prepareWorkflowImportSetup(params: {
  client: N8nApiClient;
  ctx: N8nAdminContext;
  cfg: N8nConfig;
  templateIds: string[];
  existingNames: Set<string>;
  gwgOfficerEmail: string;
}) {
  const selected = BUNDLED_N8N_WORKFLOWS.filter((candidate) =>
    params.templateIds.includes(candidate.templateId),
  );
  const missing = selected.filter(
    (template) => !params.existingNames.has(bundledWorkflowName(template)),
  );
  const requiredScopes = [...new Set(missing.flatMap((template) => template.callbackScopes))];
  const warnings: string[] = [];
  let callback: Awaited<ReturnType<typeof prepareN8nCallbackImport>> = {
    binding: null,
    configured: params.cfg.callbackConfigured,
  };
  if (requiredScopes.length) {
    try {
      callback = await prepareN8nCallbackImport(
        params.ctx,
        params.cfg,
        params.client,
        requiredScopes,
      );
      if (callback.warning) warnings.push(callback.warning);
    } catch {
      warnings.push(
        'Der Rückkanal konnte nicht automatisch vorbereitet werden. Die inaktiven Vorlagen wurden trotzdem importiert und müssen vor Veröffentlichung in Abschnitt 2 verbunden werden.',
      );
    }
  }
  const usesGwgPlaceholder =
    !params.gwgOfficerEmail &&
    missing.some((template) => template.templateId === 'taxtronik.gwg-expiry-check');
  if (usesGwgPlaceholder) {
    warnings.push(
      `Die GwG-Vorlage enthält vorerst ${DEFAULT_GWG_OFFICER_EMAIL}. Empfänger vor der Veröffentlichung in n8n ersetzen.`,
    );
  }
  return { selected, callback, warnings };
}

/**
 * Legt die gewählten, in n8n noch fehlenden Vorlagen an; je Vorlage
 * importiert, schon vorhanden oder Fehler (die übrigen laufen weiter).
 */
async function createMissingWorkflows(
  client: N8nApiClient,
  selected: readonly BundledN8nWorkflow[],
  existingNames: Set<string>,
  importValues: BundledN8nWorkflowValues,
  binding: N8nCredentialBinding | null,
): Promise<{ imported: string[]; skipped: string[]; errors: string[] }> {
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const template of selected) {
    const workflowName = bundledWorkflowName(template);
    if (existingNames.has(workflowName)) {
      skipped.push(workflowName);
      continue;
    }
    try {
      if (
        ['taxtronik.request-reminder', 'taxtronik.gwg-expiry-check'].includes(
          template.templateId,
        ) &&
        !importValues.smtpFrom
      ) {
        throw new ActionError('Mail-Absender für n8n fehlt');
      }
      const materialized = materializeBundledN8nWorkflow(template.workflow, importValues);
      const unresolved = unresolvedBundledN8nPlaceholders(materialized);
      if (unresolved.length) {
        throw new ActionError(`Einrichtungswert fehlt: ${unresolved.join(', ')}`);
      }
      await client.createWorkflow(bindN8nHeaderCredential(materialized, binding));
      imported.push(workflowName);
      existingNames.add(workflowName);
    } catch (error) {
      errors.push(`${workflowName}: ${n8nAdminErrorMessage(error)}`);
    }
  }
  return { imported, skipped, errors };
}

/** Zusammenfassung des Imports (Anzahlen und Hinweise). */
function workflowImportMessage({
  imported,
  skipped,
  errors,
  warnings,
}: Record<'imported' | 'skipped' | 'errors' | 'warnings', string[]>): string {
  const summary = [
    imported.length ? `${imported.length} importiert` : '',
    skipped.length ? `${skipped.length} vorhanden` : '',
    errors.length ? `${errors.length} Fehler` : '',
    warnings.length ? `${warnings.length} Hinweis(e)` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return `${summary || 'Nichts zu tun.'} Workflows wurden nicht automatisch aktiviert.${warnings.length ? ` ${warnings.join(' ')}` : ''}`;
}

export async function listN8nWorkflows(
  ctx: N8nAdminContext,
): Promise<N8nSettingsResult & { workflows?: N8nWorkflowRow[] }> {
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.apiBaseUrl || !cfg.apiKey)
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };
  try {
    const workflows = await new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey).listWorkflows();
    return {
      ok: true,
      workflows: workflows.map(({ id, name, active, updatedAt }) => ({
        id,
        name,
        active,
        updatedAt,
      })),
    };
  } catch (error) {
    return { ok: false, error: n8nAdminErrorMessage(error) };
  }
}

/**
 * Importiert die gewählten, noch fehlenden Vorlagen inaktiv. Geprüft wird
 * zuerst die API-Konfiguration, dann die Auswahl.
 */
export async function importN8nWorkflows(
  ctx: N8nAdminContext,
  input: unknown,
): Promise<N8nWorkflowImportResult> {
  const cfg = await readN8nConfig(ctx);
  if (!cfg?.apiBaseUrl || !cfg.apiKey)
    return { ok: false, error: 'n8n-API ist nicht konfiguriert.' };
  const parsed = WorkflowImportSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Ungültige Importwerte.' };
  }
  const knownIds = new Set(BUNDLED_N8N_WORKFLOWS.map((template) => template.templateId));
  if (parsed.data.templateIds.some((id) => !knownIds.has(id))) {
    return { ok: false, error: 'Unbekannte Workflow-Vorlage ausgewählt.' };
  }
  if (parsed.data.templateIds.length === 0) {
    return { ok: false, error: 'Bitte mindestens eine Workflow-Vorlage auswählen.' };
  }

  try {
    const client = new N8nApiClient(cfg.apiBaseUrl, cfg.apiKey);
    const existing = await client.listWorkflows();
    const existingNames = new Set(existing.map((item) => item.name));
    const setup = await prepareWorkflowImportSetup({
      client,
      ctx,
      cfg,
      templateIds: parsed.data.templateIds,
      existingNames,
      gwgOfficerEmail: parsed.data.gwgOfficerEmail,
    });
    const { selected, callback: callbackSetup, warnings } = setup;
    const smtp = await readSmtpConfig(ctx);
    const smtpFrom = parsed.data.smtpFrom || smtp?.from || env.SMTP_FROM || '';
    const importValues = {
      taxtronikApiUrl: cfg.callbackBaseUrl || defaultN8nCallbackBase(cfg.kind),
      callbackKeyId: cfg.callbackKeyId,
      smtpFrom,
      gwgOfficerEmail: parsed.data.gwgOfficerEmail || DEFAULT_GWG_OFFICER_EMAIL,
    };
    const { imported, skipped, errors } = await createMissingWorkflows(
      client,
      selected,
      existingNames,
      importValues,
      callbackSetup.binding,
    );

    const connectionId = cfg.connectionId ?? 'integrations.n8n';
    await recordEvidence(ctx, 'tenant.settings.n8n.workflows_import', connectionId, {
      imported,
      skipped,
      errors,
      warnings,
      callbackCredentialProvisioned: Boolean(callbackSetup.binding),
      autoActivated: false,
    });
    revalidateN8nSettings();
    return {
      ok: errors.length === 0,
      message: workflowImportMessage({ imported, skipped, errors, warnings }),
      error: errors.length ? errors.join('\n') : undefined,
      callbackConfigured: callbackSetup.configured,
      credential: callbackSetup.credential,
    };
  } catch (error) {
    return { ok: false, error: n8nAdminErrorMessage(error) };
  }
}
