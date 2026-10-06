// =============================================================================
// /staff/clients/:id/notices — Bescheid-Postfach pro Mandant
//
// Listet alle Bescheide mit Soll/Ist-Vergleich, Einspruchsfrist-Hinweis
// und Status. Quick-Actions: als geprüft markieren, Einspruch einlegen.
// =============================================================================

import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, FileWarning, Plus } from 'lucide-react';
import { requireClientPageAccess } from '@/server/auth/client-page-access';
import { requireModulePage } from '@/server/settings/module-page';
import { withTenantContext } from '@taxtronik/db';
import { FilingsSection } from './filings/filings-section';
import { NoticeRow } from './notice-row';
import { toNoticeRowVm } from './notice-row-vm';

import { berlinTodayUtcMidnight } from '@/lib/fmt';

export default async function ClientNoticesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: clientId } = await params;
  const session = await requireClientPageAccess(clientId);
  await requireModulePage('staff', 'taxNotices');
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

  const today = berlinTodayUtcMidnight();

  return (
    <div className="p-8 max-w-6xl">
      <Link href={`/staff/clients/${clientId}`} className="back-link">
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
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Bescheid
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Ausgangsdatum
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Festgesetzt
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Erwartet
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">Δ</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Einspruch bis
                </th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted uppercase">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {/* K-04: Fristtage, Dringlichkeit und Badges je Zeile aus dem reinen Zeilenmodell. */}
              {notices.map((n) => (
                <NoticeRow key={n.id} row={toNoticeRowVm(n, today)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
