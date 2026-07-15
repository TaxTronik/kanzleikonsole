import type { N8nTenantStatus, ServiceStatus } from '@/server/health/checks';

export interface AttentionStatus {
  attention: true;
  label: string;
  reason: string;
}

export type IntegrationRowStatus =
  | ServiceStatus
  | { skipped: true; reason: string }
  | AttentionStatus;

export interface N8nHealthPresentation {
  endpoint: string;
  status: IntegrationRowStatus;
  hint: string;
  action: { href: string; label: string };
}

export function presentN8nHealth(n8n: N8nTenantStatus): N8nHealthPresentation {
  const isLegacy = n8n.source === 'env' || n8n.source === 'legacy-setting';
  const status: IntegrationRowStatus = n8n.legacyMigrationRequired
    ? {
        attention: true,
        label: 'Migration nötig',
        reason:
          'Alte Loopback-Vorgabe erkannt: localhost beziehungsweise ::1 bezeichnet im App-Container nicht die n8n-Instanz. Bitte über die geführte Einrichtung eine erreichbare Instanz und konkrete Workflow-URLs speichern.',
      }
    : n8n.source === 'none'
      ? { skipped: true, reason: 'Keine n8n-Verbindung — in den Einstellungen einrichten' }
      : n8n.error === 'n8n-Integration bewusst deaktiviert'
        ? { skipped: true, reason: n8n.error }
        : n8n;

  const hint =
    n8n.source === 'tenant'
      ? 'Konfiguriert unter Einstellungen → Automatisierungen mit n8n.'
      : n8n.source === 'legacy-setting'
        ? 'Alte Kanzlei-Konfiguration — bitte in die workflow-spezifische n8n-Einrichtung migrieren.'
        : n8n.source === 'env'
          ? 'Legacy-ENV-Vorgabe — wird nur noch als Fallback gelesen und sollte migriert werden.'
          : 'Workflow-Engine für Reminder-Mails, Eskalationen, externe Webhooks.';

  return {
    endpoint: isLegacy ? `Legacy-Vorgabe: ${n8n.url}` : (n8n.url ?? '— nicht gesetzt —'),
    status,
    hint,
    action: {
      href: '/staff/admin/settings/n8n',
      label: isLegacy
        ? 'Legacy-Konfiguration migrieren'
        : n8n.source === 'none'
          ? 'n8n einrichten'
          : 'n8n verwalten',
    },
  };
}
