import type { GwgCheck } from '@prisma/client';
import Link from 'next/link';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { fmtDateShort } from '@/lib/fmt';
import { StartCheckCycleForm } from './start-check-cycle-form';
import type { gwgPageAvailability } from './gwg-page-model';
export function GwgCheckStatus({
  clientId,
  check,
  from,
  contacts,
  availability,
}: {
  clientId: string;
  check: GwgCheck;
  from?: string;
  contacts: Array<{ fullName: string; email: string }>;
  availability: ReturnType<typeof gwgPageAvailability>;
}) {
  return (
    <>
      {availability.destroyed && (
        <div className="rounded-md border border-default bg-subtle p-4" role="status">
          <p className="text-sm font-medium text-primary">Prüfaufzeichnung wurde vernichtet.</p>
          <p className="mt-1 text-xs text-muted">
            Die verbliebenen Status- und Verlaufsdaten dokumentieren ausschließlich die frühere
            Prüfung. Personenangaben und Nachweise stehen nicht mehr zur Bearbeitung oder Freigabe
            zur Verfügung.
          </p>
        </div>
      )}
      {!availability.destroyed &&
        !availability.expired &&
        check.status === 'VERIFIED' &&
        check.validUntil && (
          <div className="rounded-md bg-green-50 p-4 border border-green-200">
            <div className="flex items-start gap-3">
              <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-green-900">Mandant ist verifiziert.</p>
                <p className="text-xs text-green-700 mt-1">
                  Risiko: <strong>{check.riskLevel}</strong> · Gültig bis{' '}
                  {fmtDateShort(check.validUntil)}
                </p>
                {from === 'onboarding' && (
                  <Link
                    href={`/staff/clients/onboarding/${clientId}?step=poa`}
                    className="btn-primary text-xs mt-3 inline-flex"
                  >
                    Im Onboarding weiter
                  </Link>
                )}
              </div>
            </div>
          </div>
        )}
      {!availability.destroyed && check.status === 'REJECTED' && (
        <div className="rounded-md bg-red-50 p-4 border border-red-200">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-900">Prüfung abgelehnt.</p>
              {check.rejectedReason && (
                <p className="text-xs text-red-700 mt-1">Begründung: {check.rejectedReason}</p>
              )}
            </div>
          </div>
        </div>
      )}
      {!availability.destroyed && availability.expired && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900">Prüfung ist abgelaufen.</p>
              <p className="text-xs text-amber-700 mt-1">
                Für die erneute Freigabe ist ein aktueller Prüfsnapshot erforderlich.
              </p>
            </div>
          </div>
        </div>
      )}

      {(check.status === 'VERIFIED' ||
        check.status === 'REJECTED' ||
        check.status === 'EXPIRED') && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-primary mb-1">
            {check.status === 'REJECTED' ? 'Korrekturprüfung' : 'Wiederholungsprüfung'}
          </h2>
          <p className="text-xs text-muted mb-4">
            Noch aufbewahrte Identifizierungsangaben werden in einen neuen, bearbeitbaren Entwurf
            übernommen. Gelöschte oder zur Vernichtung vorgemerkte Nachweise werden nicht erneut
            verknüpft. Die alte Pflichtaufzeichnung bleibt unverändert; die Risikobewertung ist
            erneut durchzuführen.
          </p>
          <StartCheckCycleForm
            clientId={clientId}
            checkId={check.id}
            status={check.status}
            contacts={contacts.map((contact) => ({
              fullName: contact.fullName,
              email: contact.email,
            }))}
          />
        </section>
      )}
    </>
  );
}
