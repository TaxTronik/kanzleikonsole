'use client';

import { useActionState } from 'react';
import { savePortalFeaturesAction, type ActionResult } from './actions';
import type { PortalFeatures } from '@/server/settings/portal-features';
import type { PortalInboxRetentionConfig } from '@/server/inbox/retention-settings';
import { FieldError, FormErrorSummary, fieldErrorProps } from '@/components/form-errors';

const FEATURES: Array<{
  key: keyof PortalFeatures;
  label: string;
  description: string;
  dependsOn?: keyof PortalFeatures;
}> = [
  {
    key: 'appointmentRequests',
    label: 'Terminanfragen senden',
    description:
      'Mandant kann über /portal/appointments eigene Wunschtermine anfragen. Ohne dieses Recht sieht der Mandant seine bestätigten Termine, kann aber keine neuen anfragen.',
  },
  {
    key: 'bwaView',
    label: 'BWA-Auswertungen ansehen',
    description:
      'Mandant sieht Liquiditäts-Indikatoren, Jahres-Hochrechnung und seine importierten BWA-Perioden im Portal.',
  },
  {
    key: 'bwaPlanning',
    label: 'Eigene BWA-Planung anlegen',
    description:
      'Mandant darf zusätzlich eine eigene Planrechnung anlegen (7-Achsen-Wizard). Setzt „BWA ansehen" voraus.',
    dependsOn: 'bwaView',
  },
  {
    key: 'documentUpload',
    label: 'Dokumente hochladen',
    description:
      'Mandant darf eigene Dokumente ins Portal hochladen (Belege, Verträge, …). Ohne dieses Recht kann er nur antworten und ansehen.',
  },
  {
    key: 'clientInbox',
    label: 'Sicheres Nachrichtenfach',
    description:
      'Aktiviert die mandantenweit sichtbare Mandantenpost. Anlagen setzen zusätzlich „Dokumente hochladen“ voraus.',
  },
  {
    key: 'stammdatenSelfService',
    label: 'Stammdaten-Änderungen vorschlagen',
    description:
      'Mandant kann unter /portal/stammdaten Änderungen seiner Stammdaten beantragen. Genehmigung läuft weiter über die Kanzlei.',
  },
  {
    key: 'handoversView',
    label: 'Hinterlegte Unterlagen ansehen',
    description:
      'Mandant sieht unter /portal/handovers den Status seiner physisch hinterlegten Unterlagen (eingegangen, in Bearbeitung, abholbereit).',
  },
];

export function PortalFeaturesForm({
  initial,
  initialRetention,
}: {
  initial: PortalFeatures;
  initialRetention: PortalInboxRetentionConfig;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    savePortalFeaturesAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-3">
        {FEATURES.map((f) => (
          <label
            key={f.key}
            className="flex items-start gap-3"
            htmlFor={`portal-feature-${f.key}`}
            aria-label={f.label}
          >
            <input
              id={`portal-feature-${f.key}`}
              type="checkbox"
              name={f.key}
              defaultChecked={initial[f.key]}
              className="switch mt-1"
            />
            <span className="flex-1">
              <span className="block text-sm font-medium text-primary">
                {f.label}
                {f.dependsOn && (
                  <span className="ml-2 text-[10px] font-normal text-disabled">
                    setzt „{FEATURES.find((x) => x.key === f.dependsOn)?.label}" voraus
                  </span>
                )}
              </span>
              <span className="block text-xs text-secondary dark:text-disabled mt-0.5">
                {f.description}
              </span>
            </span>
          </label>
        ))}
      </div>

      <fieldset className="space-y-3 rounded-md border border-default p-4">
        <legend className="px-1 text-sm font-medium text-primary">Nachrichtenretention</legend>
        <label className="block text-sm" htmlFor="portal-inbox-retention-days">
          <span className="label">Organisatorischer Aufbewahrungswert in Tagen</span>
          <input
            id="portal-inbox-retention-days"
            className="input w-40"
            type="number"
            min={30}
            max={3650}
            name="messageRetentionDays"
            defaultValue={initialRetention.messageRetentionDays}
            {...fieldErrorProps('messageRetentionDays', state?.fieldErrors)}
          />
          <FieldError
            name="messageRetentionDays"
            errors={state?.fieldErrors?.messageRetentionDays}
          />
        </label>
        <label className="flex items-start gap-3" htmlFor="portal-inbox-retention-documented">
          <input
            id="portal-inbox-retention-documented"
            type="checkbox"
            name="retentionDocumented"
            defaultChecked={initialRetention.organizationallyDocumented}
            className="switch mt-1"
            {...fieldErrorProps('retentionDocumented', state?.fieldErrors)}
          />
          <span>
            <span className="block text-sm font-medium text-primary">
              Organisatorische Regelung ist dokumentiert
            </span>
            <span className="block text-xs text-muted">
              Der Wert ist ein betrieblicher Default und keine gesetzliche Frist. Ohne diese
              Bestätigung lässt sich clientInbox nicht aktivieren.
            </span>
          </span>
        </label>
        <FieldError name="retentionDocumented" errors={state?.fieldErrors?.retentionDocumented} />
      </fieldset>

      <p className="text-xs text-muted pt-3 border-t border-subtle">
        Diese Einstellungen wirken zusätzlich zu den Tenant-weiten Modul-Toggles. Wenn z. B. das
        BWA-Modul global deaktiviert ist, sind alle BWA-bezogenen Portal-Features automatisch
        wirkungslos.
      </p>

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichere…' : 'Speichern'}
        </button>
        {state?.ok && (
          <span className="text-sm text-emerald-700" role="status">
            Gespeichert.
          </span>
        )}
        {state && !state.ok && (
          <FormErrorSummary error={state.error} fieldErrors={state.fieldErrors} />
        )}
      </div>
    </form>
  );
}
