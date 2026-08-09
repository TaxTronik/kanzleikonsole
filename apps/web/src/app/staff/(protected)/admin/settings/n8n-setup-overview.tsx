'use client';

import { Check, ChevronRight } from 'lucide-react';
import type { N8nSetupStatus } from '@/server/n8n/status';
import { StatusCard } from './n8n-form-parts';
import type { N8nBrowserConfig, SetupStep } from './n8n-form-types';

export function N8nSetupOverview({
  initial,
  status,
  setupSteps,
}: {
  initial: N8nBrowserConfig;
  status: N8nSetupStatus;
  setupSteps: SetupStep[];
}) {
  return (
    <>
      <div className="rounded-lg border border-default bg-surface-raised p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {setupSteps.map((step, index) => (
            <div key={step.label} className="inline-flex items-center gap-2">
              <span
                className={
                  step.done
                    ? 'inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 font-medium text-muted dark:bg-gray-800'
                }
              >
                {step.done ? <Check className="h-3 w-3" /> : <span>{index + 1}</span>}
                {step.label}
              </span>
              {index < setupSteps.length - 1 && <ChevronRight className="h-3 w-3 text-disabled" />}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          {initial.source === 'ENV'
            ? 'Derzeit greift nur die Server-ENV. Speichern migriert die Verbindung in eine sichtbare Kanzlei-Konfiguration.'
            : initial.source === 'LEGACY_SETTING'
              ? 'Legacy-Konfiguration erkannt. Speichern Sie die Verbindung und ordnen Sie danach konkrete Workflow-Routen zu.'
              : 'TaxTronik kennt Verbindung, Credentials, exakte Workflow-Ziele und Zustellstatus dauerhaft.'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatusCard
          label="Integration"
          value={initial.enabled ? 'Aktiv' : 'Deaktiviert'}
          tone={initial.enabled ? 'good' : 'neutral'}
        />
        <StatusCard
          label="Aktive Routen"
          value={String(status.activeEndpointCount)}
          tone={status.activeEndpointCount ? 'good' : 'neutral'}
        />
        <StatusCard label="Wartend" value={String(status.deliveryCounts.pending)} tone="neutral" />
        <StatusCard
          label="Fehlgeschlagen"
          value={String(status.deliveryCounts.failed)}
          tone={status.deliveryCounts.failed ? 'bad' : 'good'}
        />
        <StatusCard
          label="Ohne Route"
          value={String(status.deliveryCounts.unrouted)}
          tone={status.deliveryCounts.unrouted ? 'bad' : 'good'}
        />
      </div>
    </>
  );
}
