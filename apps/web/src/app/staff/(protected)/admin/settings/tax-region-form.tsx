'use client';

import { useActionState, useState } from 'react';
import { saveTaxRegionAction, type ActionResult } from './actions';
import type { GermanRegion } from '@taxtronik/tax';
import { REGION_LABELS } from '@taxtronik/tax';

export function TaxRegionForm({
  initial,
  initialAssumptionHoliday,
}: {
  initial: GermanRegion | null;
  initialAssumptionHoliday: boolean;
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveTaxRegionAction,
    null,
  );
  const [region, setRegion] = useState<string>(initial ?? '');

  const sortedRegions = (Object.entries(REGION_LABELS) as Array<[GermanRegion, string]>).sort(
    (a, b) => a[1].localeCompare(b[1], 'de'),
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="label" htmlFor="tax-region">Bundesland der Kanzlei</label>
        <select
          id="tax-region"
          name="region"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="input"
        >
          <option value="">— nur bundesweite Feiertage —</option>
          {sortedRegions.map(([code, label]) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </select>
        <p className="text-xs text-muted mt-1">
          Beispiel: bei „Nordrhein-Westfalen" werden Fronleichnam und
          Allerheiligen als Feiertage berücksichtigt — Fälligkeiten verschieben
          sich auf den nächsten Werktag.
        </p>
      </div>
      {region === 'DE-BY' && (
        <div className="rounded-md border border-default p-3">
          <label className="flex items-start gap-2 text-sm text-secondary">
            <input
              type="checkbox"
              name="assumptionHoliday"
              defaultChecked={initialAssumptionHoliday}
              className="mt-0.5"
            />
            <span>
              Sitz-Gemeinde begeht <strong>Mariä Himmelfahrt</strong> (15.08.) als Feiertag.
              <span className="block text-xs text-muted mt-0.5">
                In Bayern nur in überwiegend katholisch geprägten Gemeinden gesetzlich
                (Art. 1 Abs. 1 BayFTG). Abwählen, wenn der Kanzleisitz ihn nicht begeht —
                sonst werden Steuertermine am 15.08. fälschlich auf den nächsten Werktag
                verschoben (Frist zu spät).
              </span>
            </span>
          </label>
        </div>
      )}

      {state?.error && (
        <div className="alert-error-sm">{state.error}</div>
      )}
      {state?.ok && (
        <div className="alert-success-sm">
          Gespeichert. Neu angelegte Termine berücksichtigen das Bundesland;
          bereits bestehende Termine werden nicht automatisch neu berechnet.
        </div>
      )}
      <button type="submit" className="btn-primary" disabled={isPending}>
        {isPending ? 'Speichert…' : 'Speichern'}
      </button>
    </form>
  );
}
