import { N8N_EVENT_CATALOG } from '@taxtronik/n8n-shared';
import { requireStaffPage } from '@/server/auth/staff-page';
import { bundledN8nWorkflowSummaries } from '@/server/n8n/bundled-workflows';
import { readN8nSetupStatus } from '@/server/n8n/status';
import { defaultN8nCallbackBase, resolveN8nConfig } from '@/server/settings/n8n';
import { readMailDispatch } from '@/server/settings/mail-dispatch';
import { MailDispatchForm } from '../mail-dispatch-form';
import { N8nForm, type N8nBrowserConfig } from '../n8n-form';
import { SectionCard } from '../section-card';

export default async function N8nSettingsPage() {
  const session = await requireStaffPage({ admin: true });
  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };
  const [cfg, status, dispatch] = await Promise.all([
    resolveN8nConfig(ctx),
    readN8nSetupStatus(ctx),
    readMailDispatch(ctx),
  ]);

  // Ausschließlich Maskierungs-Flags, niemals entschlüsselte Secrets an die
  // Client Component serialisieren.
  const browserConfig: N8nBrowserConfig = {
    connectionId: cfg.connectionId,
    name: cfg.name,
    kind: cfg.kind,
    routingMode: cfg.routingMode,
    enabled: cfg.enabled,
    uiBaseUrl: cfg.uiBaseUrl,
    callbackBaseUrl: cfg.callbackBaseUrl || defaultN8nCallbackBase(cfg.kind),
    webhookBaseUrl: cfg.webhookBaseUrl,
    apiBaseUrl: cfg.apiBaseUrl,
    hasSigningSecret: Boolean(cfg.hmacSecret),
    hasApiKey: Boolean(cfg.apiKey),
    callbackKeyId: cfg.callbackKeyId,
    callbackConfigured: cfg.callbackConfigured,
    callbackScopes: cfg.callbackScopes,
    healthCheckedAt: cfg.healthCheckedAt,
    healthOk: cfg.healthOk,
    healthError: cfg.healthError,
    source: cfg.source,
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="Automatisierungen mit n8n"
        description="Geführte Einrichtung, konkrete Workflow-URLs, tenantgebundene Rückkanäle und nachvollziehbarer Zustellstatus für mitgelieferte und eigene n8n-Workflows."
      >
        <N8nForm
          initial={browserConfig}
          status={status}
          events={N8N_EVENT_CATALOG}
          bundledWorkflows={bundledN8nWorkflowSummaries()}
        />
      </SectionCard>

      <SectionCard
        title="Mail-Dispatch"
        description="TaxTronik versendet Standardmails selbst. n8n ist eine ergänzende Automatisierung und übernimmt den Mailversand nur in bewusst dafür gebauten Workflows."
      >
        <MailDispatchForm initial={dispatch} />
      </SectionCard>
    </div>
  );
}
