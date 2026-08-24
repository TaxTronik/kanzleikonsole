import { redirect } from 'next/navigation';
import Link from 'next/link';
import { FileText, Info, CheckCircle2, AlertCircle } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';

import { fmtDateShort, fmtEUR } from '@/lib/fmt';
import { NOTICE_KIND_LABELS, NOTICE_STATUS_LABELS } from '@/lib/domain-labels';
import { shouldShowAppealDeadlineToClient } from './notice-visibility';
// Statuse, ab denen wir den Bescheid dem Mandant zeigen — vorher
// (NEU) ist er noch nicht von der Kanzlei geprüft, daher zurückhalten.
const VISIBLE_NOTICE_STATUSES = new Set([
  'GEPRUEFT',
  'EINSPRUCH',
  'ABGEHOLFEN',
  'TEILABHILFE',
  'TEILEINSPRUCHSENTSCHEIDUNG',
  'ZURUECKGEWIESEN',
  'KLAGE',
  'BESTANDSKRAEFTIG',
]);

const NOTICE_DATE_BASIS_LABELS: Record<string, string> = {
  LEGACY_UNVERIFIED: 'Ausgangsdatum (Altbestand, ungeprüft)',
  DISPATCH_DATE: 'Aufgabe-/Übermittlungstag',
  PROVISION_DATE: 'Bereitstellungstag',
  ACTUAL_ACCESS_DETERMINED: 'Fachlich festgestellter Zugangstag',
  DOCUMENT_DATE_RISK_ONLY: 'Dokumentdatum (nur Risikobasis)',
};

export default async function PortalSteuerPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, contactId, clientId } = session.user;

  const filings = await withTenantContext(
    { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
    (tx) =>
      tx.taxFiling.findMany({
        where: { clientId, sharedWithClient: true },
        orderBy: [{ filingDate: 'desc' }, { sharedAt: 'desc' }],
        include: {
          document: { select: { id: true, title: true } },
          notices: {
            orderBy: { noticeDate: 'desc' },
            take: 1,
            select: {
              id: true,
              noticeDate: true,
              dateBasis: true,
              status: true,
              assessedAmount: true,
              refundAmount: true,
              payAmount: true,
              appealDeadline: true,
              deadlineCalculationStatus: true,
              manualReviewRequired: true,
              document: { select: { id: true, title: true } },
            },
          },
        },
      }),
  );

  return (
    <div className="p-8 max-w-4xl">
      <h1 className="text-2xl font-bold text-primary mb-1">Steuererklärungen</h1>
      <p className="text-muted text-sm mb-6">
        Was Ihre Kanzlei für Sie übermittelt hat. Die endgültigen Bescheide kommen vom Finanzamt —
        die hier angegebenen Beträge sind die in DATEV/Addison vorgerechneten Werte.
      </p>

      {filings.length === 0 ? (
        <div className="card p-10 text-center">
          <Info className="h-10 w-10 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">Aktuell sind keine Erklärungen freigegeben.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {filings.map((f) => {
            const refundNum = f.expectedRefund ? Number(f.expectedRefund.toString()) : null;
            const payNum = f.expectedPay ? Number(f.expectedPay.toString()) : null;
            const saldo: number | null = refundNum ?? (payNum !== null ? -payNum : null);
            return (
              <li key={f.id} className="card p-5">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <h2 className="text-lg font-medium text-primary">
                      {NOTICE_KIND_LABELS[f.kind] ?? f.kind} {f.period}
                    </h2>
                    {f.filingDate && (
                      <p className="text-xs text-muted mt-0.5">
                        Eingereicht am {fmtDateShort(f.filingDate)}
                      </p>
                    )}
                  </div>
                  {f.document && (
                    <Link
                      href={`/api/portal/documents/${f.document.id}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-secondary text-xs py-1.5"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      Berechnung als PDF
                    </Link>
                  )}
                </div>

                <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm mb-3">
                  <KV label="Festgesetzte Steuer" value={fmtEUR(f.expectedAssessed)} />
                  <KV label="Bisherige Vorauszahlungen" value={fmtEUR(f.expectedPrepaid)} />
                  <KV
                    label="Erwartete Erstattung"
                    value={fmtEUR(f.expectedRefund)}
                    accent={f.expectedRefund ? 'positive' : undefined}
                  />
                  <KV
                    label="Erwartete Nachzahlung"
                    value={fmtEUR(f.expectedPay)}
                    accent={f.expectedPay ? 'negative' : undefined}
                  />
                </dl>

                {saldo !== null && (
                  <div
                    className={
                      'text-sm font-medium ' + (saldo >= 0 ? 'text-emerald-700' : 'text-red-700')
                    }
                  >
                    Saldo: {fmtEUR({ toString: () => String(saldo) })}
                  </div>
                )}

                {f.clientNote && (
                  <div className="mt-3 text-sm text-secondary whitespace-pre-wrap border-t border-subtle pt-3">
                    {f.clientNote}
                  </div>
                )}

                {(() => {
                  const notice = f.notices[0];
                  const expectedAssessedNum = f.expectedAssessed
                    ? Number(f.expectedAssessed.toString())
                    : null;
                  if (!notice) {
                    return (
                      <p className="mt-3 text-xs text-disabled">
                        Diese Werte basieren auf der Berechnung Ihrer Kanzlei und sind nicht
                        rechtsverbindlich. Der endgültige Bescheid des Finanzamts steht noch aus.
                      </p>
                    );
                  }
                  if (!VISIBLE_NOTICE_STATUSES.has(notice.status)) {
                    return (
                      <div className="mt-3 text-xs text-muted border-t border-subtle pt-3 flex items-center gap-1.5">
                        <Info className="h-3.5 w-3.5 text-brand-600" />
                        Bescheid liegt vor und wird von Ihrer Kanzlei geprüft.
                      </div>
                    );
                  }
                  const assessedNum = notice.assessedAmount
                    ? Number(notice.assessedAmount.toString())
                    : null;
                  const delta =
                    assessedNum !== null && expectedAssessedNum !== null
                      ? assessedNum - expectedAssessedNum
                      : null;
                  return (
                    <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/40 p-4">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div>
                          <p className="text-sm font-medium text-emerald-900 flex items-center gap-1.5">
                            <CheckCircle2 className="h-4 w-4" />
                            Bescheid vom Finanzamt eingegangen
                          </p>
                          <p className="text-xs text-emerald-800 mt-0.5">
                            {NOTICE_DATE_BASIS_LABELS[notice.dateBasis] ?? 'Ausgangsdatum'}:{' '}
                            {fmtDateShort(notice.noticeDate)}
                            {' · '}
                            Status: {NOTICE_STATUS_LABELS[notice.status] ?? notice.status}
                          </p>
                        </div>
                        {notice.document && (
                          <Link
                            href={`/api/portal/documents/${notice.document.id}/download`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-secondary text-xs py-1"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            Bescheid-PDF
                          </Link>
                        )}
                      </div>
                      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                        <KV
                          label="Festgesetzte Steuer (Ist)"
                          value={fmtEUR(notice.assessedAmount)}
                        />
                        <KV
                          label="Erstattung"
                          value={fmtEUR(notice.refundAmount)}
                          accent={notice.refundAmount ? 'positive' : undefined}
                        />
                        <KV
                          label="Nachzahlung"
                          value={fmtEUR(notice.payAmount)}
                          accent={notice.payAmount ? 'negative' : undefined}
                        />
                      </dl>
                      {delta !== null && Math.abs(delta) >= 0.01 && (
                        <p
                          className={
                            'mt-2 text-xs ' + (delta > 0 ? 'text-red-700' : 'text-emerald-700')
                          }
                        >
                          Abweichung zur Erklärung: {delta > 0 ? '+' : ''}
                          {fmtEUR({ toString: () => String(delta) })}
                          {delta > 0 ? ' höher als geschätzt' : ' niedriger als geschätzt'}
                        </p>
                      )}
                      {shouldShowAppealDeadlineToClient(notice) && (
                        <p className="mt-2 text-xs text-amber-700 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" />
                          Frist-Kontrollvorschlag bis {fmtDateShort(notice.appealDeadline!)}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function KV({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'positive' | 'negative';
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={
          'font-medium ' +
          (accent === 'positive'
            ? 'text-emerald-700'
            : accent === 'negative'
              ? 'text-red-700'
              : 'text-primary')
        }
      >
        {value}
      </dd>
    </div>
  );
}
