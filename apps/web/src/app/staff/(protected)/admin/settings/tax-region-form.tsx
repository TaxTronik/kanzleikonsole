'use client';

import { useActionState } from 'react';
import { saveTaxRegionAction, type ActionResult } from './actions';
import type { GermanRegion } from '@taxtronik/tax';
import { REGION_LABELS } from '@taxtronik/tax';

export function TaxRegionForm({ initial }: { initial: GermanRegion | null }) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveTaxRegionAction,
    null,
  );

  const sortedRegions = (Object.entries(REGION_LABELS) as Array<[GermanRegion, string]>).sort(
    (a, b) => a[1].localeCompare(b[1], 'de'),
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="tax-region">Bundesland der Kanzlei</label>
        <select id="tax-region" name="region" defaultValue={initial ?? ''} className="input">
          <option value="">— nur bundesweite Feiertage —</option>
          {sortedRegions.map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          Beispiel: bei „Nordrhein-Westfalen" werden Fronleichnam und
          Allerheiligen als Feiertage berücksichtigt — Fälligkeiten verschieben
          sich auf den nächsten Werktag.
        </p>
      </div>
      {state?.error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{state.error}</div>
      )}
      {state?.ok && (
        <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">
          Gespeichert. Bestehende Termine werden bei der nächsten Materialisierung neu berechnet.
        </div>
      )}
      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Speichern'}
      </button>
    </form>
  );
}
