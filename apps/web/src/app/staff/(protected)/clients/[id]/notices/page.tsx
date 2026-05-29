// =============================================================================
// /staff/clients/:id/notices — Bescheid-Postfach pro Mandant
//
// Listet alle Bescheide mit Soll/Ist-Vergleich, Einspruchsfrist-Hinweis
// und Status. Quick-Actions: als geprüft markieren, Einspruch einlegen.
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileWarning, Plus, FileText } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { withTenantContext } from '@taxtronik/db';
import { FilingsSection } from './filings/filings-section';

import { fmtDateShort, fmtEUR } from '@/lib/fmt';
const KIND_LABELS: Record<string, string> = {
  USTA: 'USt-Voranmeldung',
  UST_JAHR: 'USt-Jahresbescheid',
  EST: 'Einkommensteuer',
  KST: 'Körperschaftsteuer',
  GEWST_MESSBESCHEID: 'GewSt-Messbescheid',
  GEWST: 'GewSt-Bescheid',
  LSTA: 'LSt-Anmeldung',
  FESTSTELLUNG: 'Feststellungsbescheid',
  ZERLEGUNG: 'Zerlegungsbescheid',
  SONSTIGE: 'Sonstige',
};

const STATUS_LABELS: Record<string, string> = {
  NEU: 'Neu',
  GEPRUEFT: 'Geprüft',
  EINSPRUCH: 'Einspruch eingelegt',
  ABGEHOLFEN: 'Abgeholfen',
  ZURUECKGEWIESEN: 'Zurückgewiesen',
  RECHTSKRAEFTIG: 'Rechtskräftig',
};


function diff(actual: { toString(): string } | null, expected: { toString(): string } | null) {
  if (actual === null || expected === null) return null;
  const a = Number(actual.toString());
  const e = Number(expected.toString());
  if (!Number.isFinite(a) || !Number.isFinite(e)) return null;
  return a - e;
}

export default async function ClientNoticesPage({
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
        tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } }),
        tx.taxNotice.findMany({
          where: { clientId },
          orderBy: { noticeDate: 'desc' },
          include: {
            document: { select: { id: true, title: true } },
            filing: {
              select: {
                id: true,
                kind: true,
                period: true,
                sharedWithClient: true,
                expectedAssessed: true,
              },
            },
          },
        }),
        tx.taxFiling.findMany({
          where: { clientId },
          orderBy: [{ filingDate: 'desc' }, { createdAt: 'desc' }],
          include: {
            document: { select: { id: true, title: true } },
            notices: { select: { id: true }, take: 1 },
          },
        }),
      ]),
  );
  const [client, notices, filings] = data;
  if (!client) notFound();

  const now = new Date();

  return (
    <div className="p-8 max-w-6xl">
      <Link
        href={`/staff/clients/${clientId}`}
        className="back-link"
      >
        <ArrowLeft className="h-4 w-4" /> Zurück
      </Link>

      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Steuerunterlagen</h1>
          <p className="text-muted text-sm">{client.name}</p>
        </div>
        <Link href={`/staff/clients/${clientId}/notices/new`} className="btn-primary">
          <Plus className="h-4 w-4" />
          Bescheid erfassen
        </Link>
      </div>

      <FilingsSection
        clientId={clientId}
        filings={filings.map((f) => ({
          id: f.id,
          kind: f.kind,
          period: f.period,
          filingDate: f.filingDate,
          expectedAssessed: f.expectedAssessed ? Number(f.expectedAssessed.toString()) : null,
          expectedPrepaid: f.expectedPrepaid ? Number(f.expectedPrepaid.toString()) : null,
          expectedRefund: f.expectedRefund ? Number(f.expectedRefund.toString()) : null,
          expectedPay: f.expectedPay ? Number(f.expectedPay.toString()) : null,
          clientNote: f.clientNote,
          internalNote: f.internalNote,
          sharedWithClient: f.sharedWithClient,
          sharedAt: f.sharedAt,
          document: f.document,
          matchedNoticeId: f.notices[0]?.id ?? null,
        }))}
      />

      <h2 className="text-sm font-medium text-secondary uppercase tracking-wide mb-3">
        Bescheide vom Finanzamt
      </h2>
      {notices.length === 0 ? (
        <div className="card p-10 text-center">
          <FileWarning className="h-10 w-10 text-disabled mx-auto mb-3" />
          <p className="text-sm text-disabled">Keine Bescheide erfasst.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Bescheid</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Bescheid-Datum</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Festgesetzt</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Erwartet</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Î”</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Einspruch bis</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {notices.map((n) => {
                const delta = diff(n.assessedAmount, n.expectedAmount);
                const deadlineDays = n.appealDeadline
                  ? Math.ceil((n.appealDeadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
                  : null;
                const showDeadline =
                  n.appealDeadline &&
                  ['NEU', 'GEPRUEFT', 'EINSPRUCH'].includes(n.status);
                return (
                  <tr key={n.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-primary">
                        {KIND_LABELS[n.kind] ?? n.kind}
                      </div>
                      <div className="text-xs text-muted">
                        {n.period}
                        {n.fileNumber && ` · Az. ${n.fileNumber}`}
                      </div>
                      {n.document && (
                        <Link
                          href={`/api/staff/documents/${n.document.id}/download`}
                          className="text-xs text-brand-700 hover:underline inline-flex items-center gap-1 mt-1"
                        >
                          <FileText className="h-3 w-3" />
                          PDF
                        </Link>
                      )}
                      {n.filing && (
                        <div className="text-xs mt-1 flex items-center gap-1 text-muted">
                          <span>↪ aus Erklärung</span>
                          {n.filing.sharedWithClient && (
                            <span className="badge-green text-xs" title="Mandant sieht die Erklärung im Portal">
                              Portal
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-secondary">{fmtDateShort(n.noticeDate)}</td>
                    <td className="px-4 py-3 font-mono text-primary">{fmtEUR(n.assessedAmount)}</td>
                    <td className="px-4 py-3 font-mono text-secondary">{fmtEUR(n.expectedAmount)}</td>
                    <td className="px-4 py-3 font-mono">
                      {delta === null ? (
                        <span className="text-disabled">—</span>
                      ) : delta > 0 ? (
                        <span className="text-red-700">+{fmtEUR(delta)}</span>
                      ) : delta < 0 ? (
                        <span className="text-emerald-700">{fmtEUR(delta)}</span>
                      ) : (
                        <span className="text-muted">±0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {showDeadline && n.appealDeadline ? (
                        <div className="flex flex-col">
                          <span className={deadlineDays !== null && deadlineDays <= 7 ? 'text-red-700 font-medium' : 'text-secondary'}>
                            {fmtDateShort(n.appealDeadline)}
                          </span>
                          {deadlineDays !== null && (
                            <span className="text-xs text-muted">
                              {deadlineDays >= 0 ? `noch ${deadlineDays} Tage` : `${-deadlineDays} Tage abgelaufen`}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-disabled">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {n.status === 'NEU' && <span className="badge-yellow">{STATUS_LABELS[n.status]}</span>}
                      {n.status === 'GEPRUEFT' && <span className="badge-green">{STATUS_LABELS[n.status]}</span>}
                      {n.status === 'EINSPRUCH' && <span className="badge-yellow">{STATUS_LABELS[n.status]}</span>}
                      {n.status === 'ABGEHOLFEN' && <span className="badge-green">{STATUS_LABELS[n.status]}</span>}
                      {n.status === 'ZURUECKGEWIESEN' && <span className="badge-red">{STATUS_LABELS[n.status]}</span>}
                      {n.status === 'RECHTSKRAEFTIG' && <span className="badge-gray">{STATUS_LABELS[n.status]}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
