'use client';

import { Stepper, withActiveStep } from '@/components/stepper';
import type { N8nSetupStatus } from '@/server/n8n/status';
import type { N8nBrowserConfig, SetupStep } from './n8n-form-types';

// Fortschritts-Header der n8n-Einrichtung: Stepper (done/aktiv/offen) plus
// kompakte Status-Kacheln. Die Step-Labels entsprechen den Stage-Karten
// darunter (1 Verbinden … 5 Betrieb).
export function N8nSetupOverview({
  initial,
  status,
  setupSteps,
}: {
  initial: N8nBrowserConfig;
  status: N8nSetupStatus;
  setupSteps: SetupStep[];
}) {
  const steps = withActiveStep(setupSteps).map((step) => ({
    label: step.label,
    state: step.state,
  }));

  return (
    <div className="card">
      <div className="card-body" style={{ padding: 18 }}>
        <Stepper steps={steps} />
        <p className="hint" style={{ marginTop: 12 }}>
          {initial.source === 'ENV'
            ? 'Derzeit greift nur die Server-ENV. Speichern migriert die Verbindung in eine sichtbare Kanzlei-Konfiguration.'
            : initial.source === 'LEGACY_SETTING'
              ? 'Legacy-Konfiguration erkannt. Speichern Sie die Verbindung und ordnen Sie danach konkrete Workflow-Routen zu.'
              : 'Verbindung, Credentials, Workflow-Ziele und Zustellstatus sind dauerhaft gespeichert.'}
        </p>
        <div className="mini-kpis" style={{ marginTop: 14 }}>
          <div className="mini-kpi">
            <div
              className="v"
              style={{ color: initial.enabled ? '#15803d' : 'rgb(var(--text-muted))' }}
            >
              {initial.enabled ? 'Aktiv' : 'Deaktiviert'}
            </div>
            <div className="l">Integration „{initial.name || 'n8n'}“</div>
          </div>
          <div className="mini-kpi">
            <div className="v">{status.activeEndpointCount}</div>
            <div className="l">Aktive Routen</div>
          </div>
          <div className="mini-kpi">
            <div className="v">{status.deliveryCounts.pending}</div>
            <div className="l">Wartend</div>
          </div>
          <div className="mini-kpi">
            <div
              className="v"
              style={{
                color:
                  status.deliveryCounts.failed > 0 || status.deliveryCounts.unrouted > 0
                    ? '#b42318'
                    : '#15803d',
              }}
            >
              {status.deliveryCounts.failed + status.deliveryCounts.unrouted}
            </div>
            <div className="l">Fehlgeschlagen + ohne Route</div>
          </div>
        </div>
      </div>
      {!initial.enabled && status.activeEndpointCount > 0 && (
        <div className="alert-warning mx-4 mb-4">
          Es gibt aktive Routen, die Integration ist jedoch noch global gesperrt. Aktivieren Sie bei
          einer Route einmal „Integration aktivieren“; dadurch wird explizites Routing konsistent
          freigegeben.
        </div>
      )}
    </div>
  );
}
