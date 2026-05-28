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
import { TaxScheduleForm, type ScheduleConfigDto } from './tax-schedule-form';

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
    async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { id: true, name: true, allowActive: true },
      });
      const configs = await tx.taxScheduleConfig.findMany({ where: { clientId } });
      return { client, configs };
    },
  );

  if (!data.client) notFound();
  const { client, configs } = data;
  const configDtos: ScheduleConfigDto[] = configs.map((c) => ({
    kind: c.kind,
    active: c.active,
    hasDauerfrist: c.hasDauerfrist,
    reminderDaysBefore: c.reminderDaysBefore,
  }));

  return (
    <div className="p-8 max-w-3xl">
      <Link
        href={`/staff/clients/${clientId}`}
        className="back-link"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">
          Steuertermin-Konfiguration
        </h1>
        <p className="text-muted text-sm">{client.name}</p>
        <p className="text-xs text-muted mt-2">
          Beim Deaktivieren einer Termin-Art werden alle noch offenen
          Termine dieser Art aus dem Kalender entfernt. Bereits erledigte
          Termine bleiben aus Audit-Gründen erhalten.
        </p>
      </div>

      {!client.allowActive && (
        <div className="card p-4 mb-6 border-yellow-200 bg-yellow-50 dark:border-yellow-900/60 dark:bg-yellow-950/30">
          <p className="text-xs text-yellow-800 dark:text-yellow-200">
            Mandant ist nicht GwG-freigeschaltet — Termine werden nicht materialisiert.
          </p>
        </div>
      )}

      <TaxScheduleForm clientId={clientId} configs={configDtos} />
    </div>
  );
}
