// =============================================================================
// /staff/clients/:id/tax-schedule — Mandanten-Steuertermin-Konfig
//
// Ein Toggle pro Schedule-Art: aktiv ja/nein, Dauerfrist, Reminder-Tage.
// Beim Speichern wird per Server-Action die Materialisierung neu angestoßen.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import type { TaxScheduleKind } from '@prisma/client';
import { SCHEDULE_LABELS } from '@taxtronik/tax';
import { saveScheduleConfigAction } from './actions';

const ALL_KINDS: TaxScheduleKind[] = [
  'USTA_MONATLICH', 'USTA_QUARTAL', 'USTA_JAEHRLICH',
  'LSTA_MONATLICH', 'LSTA_QUARTAL', 'LSTA_JAEHRLICH',
  'EST_VZ', 'KST_VZ', 'GEWST_VZ',
  'EST_ERKLAERUNG', 'KST_ERKLAERUNG', 'GEWST_ERKLAERUNG',
];

export default async function ClientTaxSchedulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, allowActive: true } }),
        tx.taxScheduleConfig.findMany({ where: { clientId } }),
      ]),
  );

  const [client, configs] = data;
  if (!client) notFound();

  const byKind = new Map(configs.map((c) => [c.kind, c]));

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href={`/staff/clients/${clientId}`}
        className="text-sm text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Steuertermin-Konfiguration</h1>
        <p className="text-gray-500 text-sm">{client.name}</p>
        <p className="text-xs text-gray-500 mt-2">
          Beim Deaktivieren einer Termin-Art werden alle noch offenen
          Termine dieser Art aus dem Kalender entfernt. Bereits erledigte
          Termine bleiben aus Audit-Gründen erhalten.
        </p>
      </div>

      {!client.allowActive && (
        <div className="card p-4 mb-6 border-yellow-200 bg-yellow-50">
          <p className="text-xs text-yellow-800">
            Mandant ist nicht GwG-freigeschaltet — Termine werden nicht materialisiert.
          </p>
        </div>
      )}

      <form action={saveScheduleConfigAction} className="space-y-3">
        <input type="hidden" name="clientId" value={clientId} />
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Aktiv</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Termin</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Dauerfrist</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reminder (Tage)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ALL_KINDS.map((kind) => {
                const cfg = byKind.get(kind);
                const usesDauerfrist = kind.startsWith('USTA_') || kind.startsWith('LSTA_');
                return (
                  <tr key={kind}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        name={`active.${kind}`}
                        defaultChecked={cfg?.active ?? false}
                        className="rounded border-gray-300 text-brand-600"
                      />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{SCHEDULE_LABELS[kind]}</td>
                    <td className="px-4 py-3">
                      {usesDauerfrist ? (
                        <input
                          type="checkbox"
                          name={`dauerfrist.${kind}`}
                          defaultChecked={cfg?.hasDauerfrist ?? false}
                          className="rounded border-gray-300 text-brand-600"
                        />
                      ) : (
                        <span className="text-gray-300">—</span>
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
        <div className="flex justify-end">
          <button type="submit" className="btn-primary">Speichern</button>
        </div>
      </form>
    </div>
  );
}
