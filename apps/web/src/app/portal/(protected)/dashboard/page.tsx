import type { ComponentType } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Inbox, FileText, Clock, ClipboardList, CheckCircle2, Receipt } from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort, fmtEUR } from '@/lib/fmt';

export default async function PortalDashboardPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;

  const [openRequestCount, documentCount, recentRequests, todoRequests, todoForms, openInvoices] =
    await withTenantContext(
      { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' },
      async (tx) =>
        Promise.all([
          tx.request.count({
            where: { clientId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
          }),
          // Portal-Sicht: nur freigegebene & nicht soft-gelöschte Dokumente.
          tx.document.count({
            where: { clientId, deletedAt: null, sharedWithClientAt: { not: null } },
          }),
          tx.request.findMany({
            where: { clientId },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { id: true, title: true, status: true, dueAt: true },
          }),
          // „Das brauchen wir von Ihnen": offene Anforderungen + offene Formulare.
          tx.request.findMany({
            where: { clientId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
            select: { id: true, title: true, dueAt: true },
            orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
            take: 10,
          }),
          tx.formSubmission.findMany({
            where: { clientId, status: { in: ['PENDING', 'DRAFT'] } },
            select: { id: true, template: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
          // Offene Rechnungen (versendet / überfällig) — Mandant sieht sie im
          // Portal; hier als Überblick auf der Startseite.
          tx.invoice.findMany({
            where: { clientId, status: { in: ['SENT', 'OVERDUE'] } },
            select: { id: true, number: true, dueDate: true, totalAmount: true, status: true },
            orderBy: { dueDate: 'asc' },
            take: 5,
          }),
        ]),
    );

  const todoCount = todoRequests.length + todoForms.length;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-primary mb-1">
        Hallo {session.user.fullName?.split(' ')[0] ?? ''}
      </h1>
      <p className="text-muted text-sm mb-8">Übersicht über offene Anforderungen Ihrer Kanzlei.</p>

      {/* Das brauchen wir von Ihnen — alle offenen To-Dos gebündelt */}
      <div className="card overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-default flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-brand-600" />
          <h2 className="text-sm font-medium text-primary">Das brauchen wir von Ihnen</h2>
          {todoCount > 0 && <span className="badge-yellow ml-auto">{todoCount} offen</span>}
        </div>
        {todoCount === 0 ? (
          <div className="px-6 py-10 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
            <p className="text-sm text-muted">Aktuell ist nichts offen — vielen Dank!</p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {todoRequests.map((r) => (
              <li key={`req-${r.id}`} className="px-6 py-3 flex items-center justify-between gap-3">
                <Link
                  href={`/portal/requests/${r.id}`}
                  className="flex items-center gap-3 min-w-0 hover:underline"
                >
                  <Inbox className="h-4 w-4 text-yellow-600 shrink-0" />
                  <span className="text-sm text-primary truncate">{r.title}</span>
                </Link>
                <span className="text-xs text-muted shrink-0">
                  {r.dueAt ? `fällig ${fmtDateShort(r.dueAt)}` : 'Anforderung'}
                </span>
              </li>
            ))}
            {todoForms.map((f) => (
              <li
                key={`form-${f.id}`}
                className="px-6 py-3 flex items-center justify-between gap-3"
              >
                <Link
                  href={`/portal/forms/${f.id}`}
                  className="flex items-center gap-3 min-w-0 hover:underline"
                >
                  <ClipboardList className="h-4 w-4 text-brand-600 shrink-0" />
                  <span className="text-sm text-primary truncate">{f.template.name}</span>
                </Link>
                <span className="text-xs text-muted shrink-0">Formular ausfüllen</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <KpiCard
          icon={Inbox}
          label="Offene Anforderungen"
          value={openRequestCount}
          accent={openRequestCount > 0 ? 'yellow' : 'gray'}
        />
        <KpiCard icon={FileText} label="Dokumente" value={documentCount} accent="gray" />
        <KpiCard
          icon={Clock}
          label="Letzter Login"
          value={session.user.email ? '—' : '—'}
          accent="gray"
          large={false}
        />
      </div>

      <div className="card overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-default flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-brand-600" />
            <h2 className="text-sm font-medium text-primary">Offene Rechnungen</h2>
            {openInvoices.length > 0 && <span className="badge-yellow">{openInvoices.length}</span>}
          </div>
          <Link href="/portal/invoices" className="text-sm text-brand-700 hover:underline">
            Alle anzeigen
          </Link>
        </div>
        {openInvoices.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
            <p className="text-sm text-muted">Keine offenen Rechnungen.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {openInvoices.map((inv) => (
              <li key={inv.id} className="px-6 py-3 flex items-center justify-between gap-3">
                <Link
                  href="/portal/invoices"
                  className="flex items-center gap-3 min-w-0 hover:underline"
                >
                  <Receipt className="h-4 w-4 text-muted shrink-0" />
                  <span className="text-sm text-primary truncate">Rechnung {inv.number}</span>
                </Link>
                <span className="text-xs text-muted shrink-0 flex items-center gap-3">
                  <span>{fmtEUR(Number(inv.totalAmount.toString()))}</span>
                  {inv.dueDate && <span>fällig {fmtDateShort(inv.dueDate)}</span>}
                  {inv.status === 'OVERDUE' && <span className="badge-red">überfällig</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-default flex items-center justify-between">
          <h2 className="text-sm font-medium text-primary">Aktuelle Anforderungen</h2>
          <Link href="/portal/requests" className="text-sm text-brand-700 hover:underline">
            Alle anzeigen
          </Link>
        </div>
        {recentRequests.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-disabled">Keine Anforderungen.</div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {recentRequests.map((r) => (
              <li key={r.id} className="px-6 py-4">
                <Link href={`/portal/requests/${r.id}`} className="block hover:underline">
                  <span className="font-medium text-primary">{r.title}</span>
                </Link>
                <p className="text-xs text-muted mt-1">
                  {r.status === 'OPEN' || r.status === 'IN_PROGRESS' ? 'Offen' : 'Erledigt'}
                  {r.dueAt ? ` · fällig ${fmtDateShort(r.dueAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  accent,
  large = true,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  accent: 'yellow' | 'gray';
  large?: boolean;
}) {
  return (
    <div className="card p-6">
      <div className="flex items-center gap-3 mb-2">
        <Icon
          className={accent === 'yellow' ? 'h-4 w-4 text-yellow-600' : 'h-4 w-4 text-disabled'}
        />
        <span className="text-xs font-medium text-muted uppercase tracking-wide">{label}</span>
      </div>
      <p
        className={large ? 'text-3xl font-bold text-primary' : 'text-lg font-semibold text-primary'}
      >
        {value}
      </p>
    </div>
  );
}
