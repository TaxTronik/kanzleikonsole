import type { ComponentType } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  Inbox,
  FileText,
  ClipboardList,
  CheckCircle2,
  MessageSquarePlus,
  MessagesSquare,
  Receipt,
} from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort, fmtEUR } from '@/lib/fmt';
import { readModules } from '@/server/settings/modules';
import { portalDashboardVisibility } from '@/server/dashboard/portal-visibility';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { countPortalInboxNeedsClientTx } from '@/server/inbox/queries';

export default async function PortalDashboardPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;
  const ctx = { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' as const };
  const [visibility, portalFeatures] = await Promise.all([
    readModules(ctx).then(portalDashboardVisibility),
    readPortalFeatures(ctx),
  ]);

  const [
    openRequestCount,
    documentCount,
    recentRequests,
    todoRequests,
    todoForms,
    openInvoices,
    inboxNeedsClientCount,
  ] = await withTenantContext(ctx, async (tx) =>
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
      visibility.forms
        ? tx.formSubmission.findMany({
            where: { clientId, status: { in: ['PENDING', 'DRAFT'] } },
            select: { id: true, template: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 10,
          })
        : Promise.resolve([]),
      // Offene Rechnungen (versendet / überfällig) — Mandant sieht sie im
      // Portal; hier als Überblick auf der Startseite.
      visibility.invoices
        ? tx.invoice.findMany({
            where: { clientId, status: { in: ['SENT', 'OVERDUE'] } },
            select: { id: true, number: true, dueDate: true, totalAmount: true, status: true },
            orderBy: { dueDate: 'asc' },
            take: 5,
          })
        : Promise.resolve([]),
      portalFeatures.clientInbox
        ? countPortalInboxNeedsClientTx(tx, { tenantId, clientId, contactId })
        : Promise.resolve(0),
    ]),
  );

  const todoCount = todoRequests.length + todoForms.length;

  return (
    <div className="p-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-bold text-primary">
            Hallo {session.user.fullName?.split(' ')[0] ?? ''}
          </h1>
          <p className="text-sm text-muted">Übersicht über offene Anforderungen Ihrer Kanzlei.</p>
        </div>
        {portalFeatures.clientInbox ? (
          <Link href="/portal/inbox/new" className="btn-primary inline-flex items-center gap-2">
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            Nachricht an Kanzlei
          </Link>
        ) : null}
      </div>

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
            {visibility.forms &&
              todoForms.map((f) => (
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

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          icon={Inbox}
          label="Offene Anforderungen"
          value={openRequestCount}
          accent={openRequestCount > 0 ? 'yellow' : 'gray'}
        />
        <KpiCard icon={FileText} label="Dokumente" value={documentCount} accent="gray" />
        {portalFeatures.clientInbox ? (
          <KpiCard
            icon={MessagesSquare}
            label="Antwort von Ihnen benötigt"
            value={inboxNeedsClientCount}
            accent={inboxNeedsClientCount > 0 ? 'yellow' : 'gray'}
            href="/portal/inbox?attention=CLIENT&status=OPEN"
          />
        ) : null}
      </div>

      {visibility.invoices && (
        <div className="card overflow-hidden mb-8">
          <div className="px-6 py-4 border-b border-default flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Receipt className="h-4 w-4 text-brand-600" />
              <h2 className="text-sm font-medium text-primary">Offene Rechnungen</h2>
              {openInvoices.length > 0 && (
                <span className="badge-yellow">{openInvoices.length}</span>
              )}
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
      )}

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
  href,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  accent: 'yellow' | 'gray';
  large?: boolean;
  href?: string;
}) {
  const card = (
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
  return href ? (
    <Link
      href={href}
      className="rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      {card}
    </Link>
  ) : (
    card
  );
}
