'use client';

import { useActionState } from 'react';
import type { TaxScheduleKind } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { saveScheduleConfigAction, type ActionResult } from './actions';

const ALL_KINDS: TaxScheduleKind[] = [
  'USTA_MONATLICH', 'USTA_QUARTAL', 'USTA_JAEHRLICH',
  'LSTA_MONATLICH', 'LSTA_QUARTAL', 'LSTA_JAEHRLICH',
  'EST_VZ', 'KST_VZ', 'GEWST_VZ',
  'EST_ERKLAERUNG', 'KST_ERKLAERUNG', 'GEWST_ERKLAERUNG',
];

export interface ScheduleConfigDto {
  kind: TaxScheduleKind;
  active: boolean;
  hasDauerfrist: boolean;
  reminderDaysBefore: number;
}

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
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-raised border-b border-default">
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Aktiv</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Termin</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Dauerfrist</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Reminder (Tage)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {ALL_KINDS.map((kind) => {
              const cfg = byKind.get(kind);
              // Dauerfristverlaengerung gibt es NUR fuer USt-Voranmeldungen
              // (§ 18 Abs. 6 UStG, §§ 46-48 UStDV) — nicht fuer die
              // Lohnsteuer-Anmeldung (§ 41a EStG). Daher kein LSTA_.
              const usesDauerfrist = kind.startsWith('USTA_');
              return (
                <tr key={kind}>
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      name={`active.${kind}`}
                      defaultChecked={cfg?.active ?? false}
                      className="rounded border-strong text-brand-600"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium text-primary">
                    {SCHEDULE_LABELS[kind]}
                  </td>
                  <td className="px-4 py-3">
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
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      name={`reminder.${kind}`}
                      defaultValue={cfg?.reminderDaysBefore ?? 10}
                      min={0}
                      max={90}
                      className="input w-20 text-center"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
