'use client';

import { useActionState, useState } from 'react';
import type { TaxScheduleKind } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { saveScheduleConfigAction, type ActionResult } from './actions';

const ALL_KINDS: TaxScheduleKind[] = [
  'USTA_MONATLICH',
  'USTA_QUARTAL',
  'USTA_JAEHRLICH',
  'LSTA_MONATLICH',
  'LSTA_QUARTAL',
  'LSTA_JAEHRLICH',
  'EST_VZ',
  'KST_VZ',
  'GEWST_VZ',
  'EST_ERKLAERUNG',
  'KST_ERKLAERUNG',
  'GEWST_ERKLAERUNG',
];

export interface ScheduleConfigDto {
  kind: TaxScheduleKind;
  active: boolean;
  hasDauerfrist: boolean;
  advised: boolean;
  autoRequest: boolean;
  reminderDaysBefore: number;
  staffLeadDays: number;
}

// Beratene Erklärungsfrist § 149 (3) AO (letzter Februartag des ZWEITEN
// Folgejahres) gilt nur für ERKLÄRUNGEN — nicht für Anmeldungen (auch nicht
// die LSt-Jahresanmeldung) und nicht für Vorauszahlungen.
const ADVISED_KINDS = new Set<TaxScheduleKind>([
  'USTA_JAEHRLICH',
  'EST_ERKLAERUNG',
  'KST_ERKLAERUNG',
  'GEWST_ERKLAERUNG',
]);

export function TaxScheduleForm({
  clientId,
  configs,
}: {
  clientId: string;
  configs: ScheduleConfigDto[];
}) {
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    saveScheduleConfigAction,
    null,
  );
  const byKind = new Map(configs.map((c) => [c.kind, c]));

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="clientId" value={clientId} />
      {/* overflow-x-auto statt -hidden: die 7 Spalten sollen auf schmalen
          Viewports scrollen, nicht abgeschnitten werden. */}
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-raised border-b border-default">
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase whitespace-nowrap">
                Aktiv
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase whitespace-nowrap">
                Termin
              </th>
              <th className="text-left px-3 py-3 text-xs font-medium text-muted uppercase whitespace-nowrap">
                Dauerfrist
              </th>
              <th
                className="text-left px-3 py-3 text-xs font-medium text-muted uppercase whitespace-nowrap"
                title="Beratene Erklärungsfrist § 149 Abs. 3 AO — Ende Februar des zweiten Folgejahres"
              >
                Beraten (§ 149 (3))
              </th>
              <th
                className="text-left px-3 py-3 text-xs font-medium text-muted uppercase whitespace-nowrap"
                title="Automatische Unterlagen-Anforderung an den Mandanten (per Portal + E-Mail)"
              >
                Auto-Anforderung
              </th>
              <th
                className="text-left px-3 py-3 text-xs font-medium text-muted uppercase whitespace-nowrap"
                title="So viele Tage vor der Fälligkeit wird die Anforderung an den Mandanten versendet."
              >
                Versand (Tage)
              </th>
              <th
                className="text-left px-3 py-3 text-xs font-medium text-muted uppercase whitespace-nowrap"
                title="So viele Tage vor dem Versand werden die Zuständigen intern vorgewarnt und können stoppen. 0 = ohne Vorwarnung sofort am Versandtag."
              >
                Vorwarnung (Tage)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {ALL_KINDS.map((kind) => (
              <ScheduleRow key={kind} kind={kind} cfg={byKind.get(kind)} />
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted">
        Ablauf der Auto-Anforderung: Die Zuständigen werden zuerst intern vorgewarnt
        (Benachrichtigung) und können den Versand stoppen — etwa wenn der Mandant schon in
        Papierform geliefert hat. Sonst geht die Anforderung automatisch per Portal + E-Mail an alle
        aktiven Ansprechpartner raus. Deaktivieren einer Termin-Art oder eine
        Dauerfrist-/Beraten-Änderung setzt laufende Vorwarnungen und Stopps der offenen Termine
        zurück.
      </p>

      {state?.error && (
        <div className="rounded-md bg-red-50 dark:bg-red-950/40 p-3 text-sm text-red-700 dark:text-red-300">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-md bg-green-50 dark:bg-green-950/40 p-3 text-sm text-green-700 dark:text-green-300">
          Konfiguration gespeichert. Termine wurden neu materialisiert.
        </div>
      )}

      <div className="flex justify-end">
        <button type="submit" className="btn-primary" disabled={isPending}>
          {isPending ? 'Speichert…' : 'Speichern'}
        </button>
      </div>
    </form>
  );
}

function ScheduleRow({ kind, cfg }: { kind: TaxScheduleKind; cfg: ScheduleConfigDto | undefined }) {
  // Dauerfristverlaengerung gibt es NUR fuer USt-VORANMELDUNGEN
  // (§ 18 Abs. 6 UStG, §§ 46-48 UStDV) — nicht fuer die
  // Lohnsteuer-Anmeldung (§ 41a EStG) und nicht fuer die
  // USt-Jahreserklaerung (§ 149 AO).
  const usesDauerfrist = kind === 'USTA_MONATLICH' || kind === 'USTA_QUARTAL';
  // Zahlenfelder nur bedienbar, wenn die Auto-Anforderung an ist — der Server
  // ignoriert sie sonst ohnehin (disabled-Inputs werden nicht submitted, die
  // Action fällt auf die Defaults zurück; die gespeicherten Werte bleiben
  // erhalten, weil autoRequest=false den Upsert der Tage nicht anfasst).
  const [autoRequest, setAutoRequest] = useState(cfg?.autoRequest ?? true);

  return (
    <tr>
      <td className="px-3 py-3">
        <input
          type="checkbox"
          name={`active.${kind}`}
          defaultChecked={cfg?.active ?? false}
          className="rounded border-strong text-brand-600"
        />
      </td>
      <td className="px-3 py-3 font-medium text-primary whitespace-nowrap">
        {SCHEDULE_LABELS[kind]}
      </td>
      <td className="px-3 py-3">
        {usesDauerfrist ? (
          <input
            type="checkbox"
            name={`dauerfrist.${kind}`}
            defaultChecked={cfg?.hasDauerfrist ?? false}
            className="rounded border-strong text-brand-600"
          />
        ) : (
          <span className="text-disabled">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        {ADVISED_KINDS.has(kind) ? (
          <input
            type="checkbox"
            name={`advised.${kind}`}
            defaultChecked={cfg?.advised ?? false}
            className="rounded border-strong text-brand-600"
          />
        ) : (
          <span className="text-disabled">—</span>
        )}
      </td>
      <td className="px-3 py-3">
        <input
          type="checkbox"
          name={`autoRequest.${kind}`}
          checked={autoRequest}
          onChange={(e) => setAutoRequest(e.target.checked)}
          className="rounded border-strong text-brand-600"
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          name={`reminder.${kind}`}
          defaultValue={cfg?.reminderDaysBefore ?? 10}
          min={1}
          max={90}
          disabled={!autoRequest}
          className="input w-20 text-center disabled:opacity-40"
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          name={`lead.${kind}`}
          defaultValue={cfg?.staffLeadDays ?? 3}
          min={0}
          max={30}
          disabled={!autoRequest}
          title="0 = ohne Vorwarnung sofort am Versandtag"
          className="input w-20 text-center disabled:opacity-40"
        />
      </td>
    </tr>
  );
}
