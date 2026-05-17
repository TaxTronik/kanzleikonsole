// =============================================================================
// /portal/handovers — Mandanten-Sicht "Hinterlegte Unterlagen"
//
// Mandant sieht den Status seiner physischen Anlieferungen:
//   - Eingegangen / In Bearbeitung — Hinweis, dass Kanzlei dran ist
//   - Abholbereit — prominent grün, Bitte abholen
//   - Abgeholt — Historie (collapsed)
// =============================================================================

import { redirect } from 'next/navigation';
import { Inbox, CheckCircle2, Clock } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { readPortalFeatures } from '@/server/settings/portal-features';

const dateFmt = new Intl.DateTimeFormat('de-DE');

const STATUS_LABELS = {
  RECEIVED: 'Eingegangen',
  IN_PROGRESS: 'In Bearbeitung',
  READY: 'Abholbereit',
  PICKED_UP: 'Abgeholt',
} as const;

export default async function PortalHandoversPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;
  const features = await readPortalFeatures({ tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' });
  if (!features.handoversView) redirect('/portal/dashboard');

  const handovers = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.clientHandover.findMany({
        where: { clientId },
        orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
        take: 100,
      }),
  );

  const ready = handovers.filter((h) => h.status === 'READY');
  const inProgress = handovers.filter((h) => h.status === 'RECEIVED' || h.status === 'IN_PROGRESS');
  const pickedUp = handovers.filter((h) => h.status === 'PICKED_UP');

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-1 flex items-center gap-2">
          <Inbox className="h-6 w-6 text-brand-600" />
          Hinterlegte Unterlagen
        </h1>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          Status der Unterlagen, die Sie bei uns abgegeben haben.
        </p>
      </div>

      {ready.length > 0 && (
        <div className="card overflow-hidden mb-6 border-l-4 border-l-emerald-500">
          <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Bereit zur Abholung ({ready.length})
            </h2>
          </div>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {ready.map((h) => (
              <li key={h.id} className="px-6 py-3">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{h.label}</p>
                {h.contents && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 whitespace-pre-wrap">{h.contents}</p>
                )}
                <p className="text-xs text-emerald-700 mt-1">
                  {h.readyAt ? `seit ${dateFmt.format(h.readyAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inProgress.length > 0 && (
        <div className="card overflow-hidden mb-6">
          <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              In Bearbeitung ({inProgress.length})
            </h2>
          </div>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {inProgress.map((h) => (
              <li key={h.id} className="px-6 py-3">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
                  {h.label}
                  <span className="badge-yellow text-[10px]">{STATUS_LABELS[h.status]}</span>
                </p>
                {h.contents && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 whitespace-pre-wrap">{h.contents}</p>
                )}
                <p className="text-xs text-gray-500 mt-1">
                  abgegeben am {dateFmt.format(h.receivedAt)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {handovers.length === 0 && (
        <div className="card p-10 text-center">
          <Inbox className="h-10 w-10 text-gray-200 mx-auto mb-3" />
          <p className="text-sm text-gray-400">Aktuell sind keine Unterlagen bei uns hinterlegt.</p>
        </div>
      )}

      {pickedUp.length > 0 && (
        <details className="card overflow-hidden">
          <summary className="px-6 py-3 text-sm text-gray-500 cursor-pointer">
            {pickedUp.length} bereits abgeholt
          </summary>
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {pickedUp.map((h) => (
              <li key={h.id} className="px-6 py-2 text-sm text-gray-500 flex justify-between">
                <span className="truncate">{h.label}</span>
                {h.pickedUpAt && <span className="text-xs">{dateFmt.format(h.pickedUpAt)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
