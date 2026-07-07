import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, FileText, X } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { canAccessClientTx, hasStaffPermission } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { markPaidAction, cancelInvoiceAction } from '../actions';
import { computeVatTotals } from '@/server/invoicing/vat';
import { MarkSentForm } from './mark-sent-form';
import { InvoiceFormatDownload } from './invoice-format-download';

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
  // XRechnung (reine XML) ist das strikt EN-16931-/PDF-A-konforme Leitformat für
  // B2B/B2G. ZUGFeRD ist ein Hybrid-PDF mit eingebetteter Factur-X-XML — kein
  // strikt validiertes PDF/A-3 (nicht eingebettete Standard-Fonts).
  XRECHNUNG: 'XRechnung (XML) — führend',
  ZUGFERD: 'ZUGFeRD/Factur-X (Hybrid-PDF, EN 16931)',
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

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const row = await tx.invoice.findUnique({
        where: { id },
        include: {
          client: true,
          positions: { orderBy: { position: 'asc' } },
          document: true,
          stornoOf: { select: { id: true, number: true } },
          stornoBy: { select: { id: true, number: true } },
        },
      });
      // Zugriffsmodell (vertraulich-Flag / RESTRICTED): Rechnung eines
      // gesperrten Mandanten verhält sich wie nicht vorhanden.
      if (row && !(await canAccessClientTx(tx, session, row.clientId))) return null;
      if (!row) return null;

      const artifactOr: Array<{ id: string } | { title: { in: string[] } }> = [
        { title: { in: [`Rechnung ${row.number} (ZUGFeRD)`, `Rechnung ${row.number} (XRechnung)`] } },
      ];
      if (row.documentId) artifactOr.push({ id: row.documentId });

      const artifacts = await tx.document.findMany({
        where: {
          tenantId,
          clientId: row.clientId,
          classification: 'GOBD_INVOICE',
          deletedAt: null,
          versions: { some: {} },
          OR: artifactOr,
        },
        orderBy: { createdAt: 'desc' },
      });

      return { invoice: row, artifacts };
    },
  );

  if (!data) notFound();
  const inv = data.invoice;
  const invoiceDocuments = data.artifacts;
  const hasXRechnung = invoiceDocuments.some((d) =>
    d.title === `Rechnung ${inv.number} (XRechnung)` ||
    d.mimeType.toLowerCase().includes('xml'),
  );
  const hasZugferd = invoiceDocuments.some((d) =>
    d.id === inv.documentId ||
    d.title === `Rechnung ${inv.number} (ZUGFeRD)`,
  );
  const canGenerateFormats = inv.format !== 'PDF';

  // iter87: Buttons nur mit Einzelrecht zeigen — die Actions prüfen selbst
  // (UI-Ausblendung ist Komfort, kein Schutz).
  const canManage = hasStaffPermission(session, 'INVOICE_MANAGE');
  const canSend = hasStaffPermission(session, 'INVOICE_SEND');

  // iter86: USt-Ausweis je Steuersatz-Gruppe (§ 14 Abs. 4 Nr. 8 UStG).
  const vatGroups = computeVatTotals(
    inv.positions.map((p) => ({ netAmount: Number(p.netAmount), vatRate: Number(p.vatRate) })),
  ).groups;

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
            {inv.stornoOfId && <span className="badge-red">Stornorechnung</span>}
          </div>
          {inv.stornoOf && (
            <p className="text-xs text-red-700">
              Storno zu Rechnung{' '}
              <Link href={`/staff/invoices/${inv.stornoOf.id}`} className="underline">{inv.stornoOf.number}</Link>
            </p>
          )}
          {inv.stornoBy.length > 0 && (
            <p className="text-xs text-amber-700">
              Storniert durch{' '}
              {inv.stornoBy.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && ', '}
                  <Link href={`/staff/invoices/${s.id}`} className="underline">{s.number}</Link>
                </span>
              ))}
            </p>
          )}
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
              <th className="th th-right">USt %</th>
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
                  {Number(p.vatRate).toLocaleString('de-DE')}
                </td>
                <td className="td-num">
                  {fmtEUR(p.netAmount)}
                </td>
              </tr>
            ))}
            <tr className="bg-gray-50">
              <td colSpan={5} className="px-6 py-3 text-right text-secondary">Netto</td>
              <td className="td-num">{fmtEUR(inv.netAmount)}</td>
            </tr>
            {/* iter86: USt-Ausweis je Steuersatz-Gruppe (§ 14 Abs. 4 Nr. 8 UStG) */}
            {vatGroups.map((g) => (
              <tr key={g.rate} className="bg-gray-50">
                <td colSpan={5} className="px-6 py-3 text-right text-secondary">
                  USt ({g.rate.toLocaleString('de-DE')} %)
                </td>
                <td className="td-num">{fmtEUR(g.vat)}</td>
              </tr>
            ))}
            <tr className="bg-gray-100 font-bold">
              <td colSpan={5} className="px-6 py-3 text-right text-primary">Brutto</td>
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

      {invoiceDocuments.length > 0 && (
        <div className="card p-4 mb-6">
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">Rechnungsdateien</h3>
          <div className="divide-y divide-border-subtle">
            {invoiceDocuments.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex items-center gap-3">
                  <FileText className="h-4 w-4 text-muted shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-secondary truncate">{doc.title}</p>
                    <p className="text-xs text-disabled">{doc.mimeType}</p>
                  </div>
                </div>
                <a
                  href={`/api/staff/documents/${doc.id}/download`}
                  className="text-sm text-brand-700 hover:underline shrink-0"
                >
                  Öffnen
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {canGenerateFormats && !hasXRechnung && (
          <InvoiceFormatDownload
            href={`/api/staff/invoices/${inv.id}/xrechnung`}
            label="XRechnung (XML)"
            title="XRechnung 3.0 (XML) herunterladen"
          />
        )}
        {canGenerateFormats && !hasZugferd && (
          <InvoiceFormatDownload
            href={`/api/staff/invoices/${inv.id}/zugferd`}
            label="ZUGFeRD (PDF)"
            title="ZUGFeRD/Factur-X PDF (mit eingebetteter XRechnung-XML) herunterladen"
          />
        )}
        {inv.status === 'DRAFT' && canSend && (
          <MarkSentForm invoiceId={inv.id} />
        )}
        {(inv.status === 'SENT' || inv.status === 'OVERDUE') && canManage && (
          <form action={markPaidAction}>
            <input type="hidden" name="invoiceId" value={inv.id} />
            <button type="submit" className="btn-primary">
              <CheckCircle2 className="h-4 w-4" />
              Als bezahlt markieren
            </button>
          </form>
        )}
        {inv.status !== 'CANCELLED' && inv.status !== 'PAID' && canManage && (
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
