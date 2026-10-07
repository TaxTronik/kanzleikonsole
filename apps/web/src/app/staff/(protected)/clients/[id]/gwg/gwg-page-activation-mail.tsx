// =============================================================================
// Zustellstatus der Begrüßungsmail nach der GwG-Freischaltung (C4)
//
// Die Erstfreigabe legt die Begrüßungsmail an die bestätigten Kontakte als
// Versandauftrag an. Bisher erfuhr die Kanzlei nur bei einem Fehlschlag per
// Benachrichtigung davon; jetzt steht der Stand dort, wo freigegeben wurde,
// samt „Erneut senden" für fehlgeschlagene oder unklare Aufträge.
// =============================================================================

import { MailDeliveryStatusList } from '@/components/mail-delivery-status';
import type { MailDeliverySummary } from '@/lib/mail-delivery-status';

export function GwgActivationMail({ summaries }: { summaries: readonly MailDeliverySummary[] }) {
  if (summaries.length === 0) return null;
  return (
    <section className="card p-4" aria-label="Begrüßungsmail nach der Freischaltung">
      <h2 className="text-sm font-semibold text-primary mb-1">Begrüßungsmail an den Mandanten</h2>
      <MailDeliveryStatusList summaries={summaries} />
    </section>
  );
}
