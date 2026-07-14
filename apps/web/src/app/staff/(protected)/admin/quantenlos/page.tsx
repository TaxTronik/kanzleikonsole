// =============================================================================
// /staff/admin/quantenlos — Quantenlos: beweisbar blinde Compliance-Stichprobe.
//
// Zieht k Subsumtionen eines Zeitraums als Review-Stichprobe — die Auswahl
// trifft die Risk-Engine aus echter (QPU-)Entropie über ein Commitment auf den
// ID-Rahmen: niemand (auch die Kanzlei nicht) kann die Auswahl vorab steuern.
// Nachweis liegt in der Audit-Hash-Chain; je Treffer entsteht eine Review-
// Wiedervorlage. Admin/Partner-only (Compliance-Hoheit, wie Audit-Log).
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import { readModules } from '@/server/settings/modules';
import { getIbmTokenStatus } from '@/server/settings/quantenlos';
import { buildLosRahmen, getPendingLos, listLosZiehungen } from '@/server/risk';
import { QuantenlosPanel } from './quantenlos-panel';

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function QuantenlosPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) redirect('/staff/dashboard');

  const { tenantId, staffId } = session.user;
  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  const modules = await readModules(ctx);
  const engineOk = isRiskLayerConfigured();
  const bereit = modules.risk && engineOk;

  // Default-Zeitraum: die letzten 90 Tage.
  const bis = new Date();
  const von = new Date(bis.getTime() - 90 * 24 * 60 * 60 * 1000);
  const zeitraum = { von: ymd(von), bis: ymd(bis) };

  const [rahmen, pending, ziehungen, ibmToken] = bereit
    ? await Promise.all([
        buildLosRahmen(ctx, zeitraum),
        getPendingLos(ctx),
        listLosZiehungen(ctx, 10),
        getIbmTokenStatus(ctx),
      ])
    : [[], null, [], { hinterlegt: false, suffix: null, gesetztAm: null }];

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Quantenlos — blinde Stichprobe</h1>
        <p className="text-muted text-sm dark:text-white">
          Beweisbar blinde Review-Stichprobe — wahlweise über die Subsumtionen eines Zeitraums
          (Risk-Review) oder über die Audit-Ereignisse (Betriebs-Nachschau). Die Engine committet
          auf den ID-Rahmen, BEVOR sie zieht — die Auswahl ist nachweislich nicht steuerbar. Der
          Nachweis wird in der Audit-Hash-Chain verankert.
        </p>
      </div>

      {!bereit ? (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 p-4 flex items-start gap-3 dark:border-yellow-900/60 dark:bg-yellow-900/20">
          <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 dark:text-yellow-300" />
          <div className="text-sm text-yellow-900 dark:text-yellow-100">
            {!modules.risk ? (
              <p>
                Das Subsumtions-Modul ist deaktiviert — Quantenlos setzt es voraus.{' '}
                <Link href="/staff/admin/settings" className="underline">
                  Zu den Einstellungen
                </Link>
              </p>
            ) : (
              <p>
                Die Risk-Engine ist nicht konfiguriert (RISK_LAYER_URL/RISK_LAYER_TOKEN) —
                Quantenlos ist derzeit nicht verfügbar.
              </p>
            )}
          </div>
        </div>
      ) : (
        <QuantenlosPanel
          initialZeitraum={zeitraum}
          initialN={rahmen.length}
          initialPending={pending}
          initialZiehungen={ziehungen}
          initialIbmToken={ibmToken}
        />
      )}
    </div>
  );
}
