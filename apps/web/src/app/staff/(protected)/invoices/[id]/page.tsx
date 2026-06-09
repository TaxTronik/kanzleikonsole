import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Send, CheckCircle2, X, FileCode } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { markSentAction, markPaidAction, cancelInvoiceAction } from '../actions';

import { fmtDateShort, fmtEUR } from '@/lib/fmt';
const statusLabels: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'Versendet',
  PAID: 'Bezahlt',
  OVERDUE: 'Überfällig',
  CANCELLED: 'Storniert',
};

const formatLabels: Record<string, string> = {
  PDF: 'PDF',
  XRECHNUNG: 'XRechnung (XML)',
  ZUGFERD: 'ZUGFeRD (Hybrid PDF/A-3)',
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');

  const { id } = await params;
  const { tenantId, staffId } = session.user;

  const inv = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const row = await tx.invoice.findUnique({
        where: { id },
        include: {
          client: true,
          positions: { orderBy: { position: 'asc' } },
          document: true,
        },
      });
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Rechnung eines
      // gesperrten Mandanten verhält sich wie nicht vorhanden.
      if (row && !(await canAccessClientTx(tx, session, row.clientId))) return null;
      return row;
    },
  );

  if (!inv) notFound();

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/invoices" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold text-primary">
              Rechnung {inv.number}
            </h1>
            {inv.status === 'DRAFT' && <span className="badge-gray">{statusLabels[inv.status]}</span>}
            {inv.status === 'SENT' && <span className="badge-yellow">{statusLabels[inv.status]}</span>}
            {inv.status === 'PAID' && <span className="badge-green">{statusLabels[inv.status]}</span>}
            {inv.status === 'OVERDUE' && <span className="badge-red">{statusLabels[inv.status]}</span>}
            {inv.status === 'CANCELLED' && <span className="badge-gray">{statusLabels[inv.status]}</span>}
          </div>
          <p className="text-muted text-sm">
            an{' '}
            <Link href={`/staff/clients/${inv.client.id}`} className="hover:underline">
              {inv.client.name}
            </Link>
            {' · '}
            {formatLabels[inv.format]}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <KV label="Betreff" value={inv.subject} />
        <KV
          label="Rechnungsdatum"
          value={fmtDateShort(inv.issueDate)}
        />
        <KV
          label="Fällig"
          value={fmtDateShort(inv.dueDate)}
        />
      </div>

      <div className="card overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="th">Pos</th>
              <th className="th">Beschreibung</th>
              <th className="th th-right">Menge</th>
              <th className="th th-right">Einzelpreis</th>
              <th className="th th-right">Netto</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {inv.positions.map((p) => (
              <tr key={p.id}>
                <td className="px-6 py-3 text-muted">{p.position}</td>
                <td className="px-6 py-3 text-primary">{p.description}</td>
                <td className="px-6 py-3 text-right font-mono tabular-nums text-secondary">
                  {Number(p.quantity).toLocaleString('de-DE')} {p.unit}
                </td>
                <td className="td-num">
                  {fmtEUR(p.unitPrice)}
                </td>
                <td className="td-num">
                  {fmtEUR(p.netAmount)}
                </td>
              </tr>
            ))}
            <tr className="bg-gray-50">
              <td colSpan={4} className="px-6 py-3 text-right text-secondary">Netto</td>
              <td className="td-num">{fmtEUR(inv.netAmount)}</td>
            </tr>
            <tr className="bg-gray-50">
              <td colSpan={4} className="px-6 py-3 text-right text-secondary">
                USt ({Number(inv.vatRate)} %)
              </td>
              <td className="td-num">{fmtEUR(inv.vatAmount)}</td>
            </tr>
            <tr className="bg-gray-100 font-bold">
              <td colSpan={4} className="px-6 py-3 text-right text-primary">Brutto</td>
              <td className="px-6 py-3 text-right font-mono tabular-nums text-primary">{fmtEUR(inv.totalAmount)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {inv.notes && (
        <div className="card p-6 mb-6">
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-2">Notizen</h3>
          <p className="text-sm text-secondary whitespace-pre-wrap">{inv.notes}</p>
        </div>
      )}

      {inv.document && (
        <div className="card p-4 mb-6 flex items-center justify-between">
          <span className="text-sm text-secondary">PDF: {inv.document.title}</span>
          <a
            href={`/api/staff/documents/${inv.document.id}/download`}
            className="text-sm text-brand-700 hover:underline"
          >
            Öffnen
          </a>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <a
          href={`/api/staff/invoices/${inv.id}/xrechnung`}
          className="btn-secondary"
          title="XRechnung 3.0 (XML) herunterladen"
        >
          <FileCode className="h-4 w-4" />
          XRechnung (XML)
        </a>
        <a
          href={`/api/staff/invoices/${inv.id}/zugferd`}
          className="btn-secondary"
          title="ZUGFeRD/Factur-X PDF (mit eingebetteter XRechnung-XML) herunterladen"
        >
          <FileCode className="h-4 w-4" />
          ZUGFeRD (PDF)
        </a>
        {inv.status === 'DRAFT' && (
          <form action={markSentAction}>
            <input type="hidden" name="invoiceId" value={inv.id} />
            <button type="submit" className="btn-primary">
              <Send className="h-4 w-4" />
              Als versendet markieren
            </button>
          </form>
        )}
        {(inv.status === 'SENT' || inv.status === 'OVERDUE') && (
          <form action={markPaidAction}>
            <input type="hidden" name="invoiceId" value={inv.id} />
            <button type="submit" className="btn-primary">
              <CheckCircle2 className="h-4 w-4" />
              Als bezahlt markieren
            </button>
          </form>
        )}
        {inv.status !== 'CANCELLED' && inv.status !== 'PAID' && (
          <form action={cancelInvoiceAction}>
            <input type="hidden" name="invoiceId" value={inv.id} />
            <button type="submit" className="btn-secondary text-red-700 border-red-300 hover:bg-red-50">
              <X className="h-4 w-4" />
              Stornieren
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow">{label}</p>
      <p className="text-sm font-medium text-primary">{value}</p>
    </div>
  );
}

