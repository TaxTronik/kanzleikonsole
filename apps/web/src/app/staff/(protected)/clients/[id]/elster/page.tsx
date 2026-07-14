// =============================================================================
// /staff/clients/[id]/elster — Steuerkonto (ELSTER-Kontoabfrage, Stufe 2).
//
// Sichtbar nur mit konfigurierter eric-bridge (isElsterConfigured); ohne
// Steuernummer am Mandanten zeigt die Seite den Erfassungs-Hinweis. Die
// Abruf-Historie ist append-only (jeder Abruf = ELSTER-Vorgang).
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Landmark } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { isElsterConfigured } from '@taxtronik/elster';
import { fmtDateTimeShort } from '@/lib/fmt';
import { KontoabfrageForm } from './kontoabfrage-form';

const ART_LABELS: Record<string, string> = {
  ZS: 'Sollstellungen',
  O: 'Offene Beträge',
  I: 'Istbuchungen',
};

export default async function ElsterPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { id: clientId } = await params;
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true, steuernummer: true },
      });
      if (!client) return null;
      const abfragen = await tx.elsterKontoabfrage.findMany({
        where: { clientId },
        orderBy: { createdAt: 'desc' },
        take: 25,
      });
      return { client, abfragen };
    },
  );
  if (!data) notFound();
  const { client, abfragen } = data;
  const configured = isElsterConfigured();

  return (
    <div className="p-8 max-w-4xl">
      <Link href={`/staff/clients/${clientId}`} className="back-link">
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="mb-6 flex items-start gap-3">
        <Landmark className="h-6 w-6 text-brand-600 mt-1" />
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Steuerkonto (ELSTER)</h1>
          <p className="text-muted text-sm">
            {client.name}
            {client.steuernummer ? (
              <>
                {' '}
                · StNr <span className="font-mono">{client.steuernummer}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      {!configured ? (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/40 p-4 text-sm text-yellow-800 dark:text-yellow-300">
          Die ELSTER-Bridge ist nicht konfiguriert (<code>ELSTER_BRIDGE_URL</code>/
          <code>ELSTER_BRIDGE_TOKEN</code>). Ohne Bridge bleibt das Steuerkonto inaktiv — Deployment
          siehe eric-bridge-Doku.
        </div>
      ) : !client.steuernummer ? (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/40 p-4 text-sm text-yellow-800 dark:text-yellow-300">
          Für diesen Mandanten ist keine Steuernummer hinterlegt.{' '}
          <Link href={`/staff/clients/${clientId}/edit`} className="underline font-medium">
            Jetzt unter „Bearbeiten" erfassen
          </Link>{' '}
          (13-stelliges ELSTER-Bundesformat).
        </div>
      ) : (
        <KontoabfrageForm clientId={clientId} />
      )}

      <h2 className="text-sm font-semibold text-primary mt-8 mb-3">
        Abruf-Historie{abfragen.length > 0 ? ` (${abfragen.length})` : ''}
      </h2>
      {abfragen.length === 0 ? (
        <p className="text-sm text-disabled">Noch keine Abfragen.</p>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-raised border-b border-default">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Zeitpunkt
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Art
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Steuerart
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Zeitraum
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Modus
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {abfragen.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-3 text-secondary">{fmtDateTimeShort(a.createdAt)}</td>
                  <td className="px-4 py-3 text-primary">{ART_LABELS[a.art] ?? a.art}</td>
                  <td className="px-4 py-3 text-secondary">{a.steuerart ?? '—'}</td>
                  <td className="px-4 py-3 text-secondary font-mono">{a.zeitraum ?? '—'}</td>
                  <td className="px-4 py-3">
                    {a.echtfall ? (
                      <span className="badge badge-red">Echtfall</span>
                    ) : (
                      <span className="badge badge-gray">Test</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {a.ok ? (
                      <span className="badge badge-green">OK</span>
                    ) : (
                      <span className="badge badge-red" title={a.errorText ?? undefined}>
                        Fehler ({a.returnCode})
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
