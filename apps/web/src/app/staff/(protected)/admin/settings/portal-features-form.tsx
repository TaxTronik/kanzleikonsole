'use client';

import { useActionState } from 'react';
import { savePortalFeaturesAction, type ActionResult } from './actions';
import type { PortalFeatures } from '@/server/settings/portal-features';

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

export function PortalFeaturesForm({ initial }: { initial: PortalFeatures }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    savePortalFeaturesAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-3">
        {FEATURES.map((f) => (
          <label key={f.key} className="flex items-start gap-3">
            <input
              type="checkbox"
              name={f.key}
              defaultChecked={initial[f.key]}
              className="mt-1 rounded border-strong text-brand-600"
            />
            <div className="flex-1">
              <div className="text-sm font-medium text-primary">
                {f.label}
                {f.dependsOn && (
                  <span className="ml-2 text-[10px] font-normal text-disabled">
                    setzt „{FEATURES.find((x) => x.key === f.dependsOn)?.label}" voraus
                  </span>
                )}
              </div>
              <div className="text-xs text-secondary dark:text-disabled mt-0.5">
                {f.description}
              </div>
            </div>
          </label>
        ))}
      </div>

      <p className="text-xs text-muted pt-3 border-t border-subtle">
        Diese Einstellungen wirken zusätzlich zu den Tenant-weiten Modul-Toggles. Wenn z. B. das
        BWA-Modul global deaktiviert ist, sind alle BWA-bezogenen Portal-Features automatisch
        wirkungslos.
      </p>

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichere…' : 'Speichern'}
        </button>
        {state?.ok && <span className="text-sm text-emerald-700">Gespeichert.</span>}
        {state && !state.ok && <span className="text-sm text-red-700">{state.error}</span>}
      </div>
    </form>
  );
}
