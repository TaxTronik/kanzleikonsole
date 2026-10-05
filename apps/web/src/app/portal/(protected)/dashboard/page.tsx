import type { ComponentType } from 'react';
import type { Prisma } from '@prisma/client';
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
  UserCheck,
} from 'lucide-react';
import { portalAuth } from '@/server/auth/portal';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateShort, fmtEUR } from '@/lib/fmt';
import { readModules, type ModuleConfig } from '@/server/settings/modules';
import { portalDashboardVisibility } from '@/server/dashboard/portal-visibility';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { countPortalInboxNeedsClientTx } from '@/server/inbox/queries';
import { isPortalFormOpen, PORTAL_FORM_OPEN_STATUSES } from '@/server/portal/form-open';
import { noticeDecisionSnapshot } from '@/server/workflows/interactions';

// Startseite zeigt nur einen Ausschnitt; die vollständigen Listen liegen unter
// /portal/requests, /portal/forms und /portal/invoices.
const TODO_LIST_CAP = 10;
const OPEN_INVOICES_CAP = 5;
const FEEDBACK_INTERACTION_TITLE = 'Wie zufrieden sind Sie mit unserer Zusammenarbeit?';

function interactionTitle(kind: string, snapshot: unknown): string {
  if (kind !== 'NOTICE') return FEEDBACK_INTERACTION_TITLE;
  const parsed = noticeDecisionSnapshot.safeParse(snapshot);
  return parsed.success ? parsed.data.title : 'Rückfrage zu Ihrem Bescheid';
}

type PortalContactContext = {
  tenantId: string;
  actorId: string;
  actorType: 'CLIENT_CONTACT';
};

/**
 * Daten der Startseite in einer Tenant-Transaktion. Zähler und gekappte Listen
 * nutzen jeweils denselben Filter (F-14); Modulschalter entscheiden, was
 * überhaupt abgefragt wird.
 */
async function loadPortalDashboard(
  ctx: PortalContactContext,
  clientId: string,
  modules: ModuleConfig,
  clientInbox: boolean,
) {
  const { tenantId, actorId: contactId } = ctx;
  const visibility = portalDashboardVisibility(modules);
  // Persönliche Rückfragen: dieselben Modulschalter wie /portal/interactions.
  const interactionKinds = [
    ...(modules.noticeDecisions && modules.taxNotices ? ['NOTICE'] : []),
    ...(modules.feedbackSurveys ? ['FEEDBACK'] : []),
  ];
  const openInvoiceWhere: Prisma.InvoiceWhereInput = {
    clientId,
    status: { in: ['SENT', 'OVERDUE'] },
  };
  const openInteractionWhere: Prisma.ClientInteractionWhereInput = {
    clientId,
    contactId,
    status: 'OPEN',
    expiresAt: { gt: new Date() },
    kind: { in: interactionKinds },
  };
  const [
    openRequestCount,
    documentCount,
    recentRequests,
    todoRequests,
    formCandidates,
    openInvoices,
    openInvoiceCount,
    inboxNeedsClientCount,
    todoInteractions,
    openInteractionCount,
  ] = await withTenantContext(ctx, async (tx) => {
    // Fachkatalog REQ-LIFECYCLE-001 / TAX-NOTICE-DECISION-001: persönlich
    // gebundene Bescheid- und Feedbackanfragen laufen ausschließlich über
    // ihren kontaktgebundenen Portalpfad. Wie /portal/requests zählt und listet
    // die Startseite sie nicht als allgemeine Anforderung — sonst sähen auch
    // andere Kontakte desselben Mandats Titel und Anzahl. Der Kontakt selbst
    // sieht seine offenen Rückfragen als eigenes To-do.
    const interactionRequests = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT r.id FROM public.request r
      WHERE r.client_id = ${clientId}::uuid AND app.interaction_request(r.id)`;
    const clientRequestWhere: Prisma.RequestWhereInput = interactionRequests.length
      ? { clientId, id: { notIn: interactionRequests.map((row) => row.id) } }
      : { clientId };
    const openRequestWhere: Prisma.RequestWhereInput = {
      ...clientRequestWhere,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
    };
    return Promise.all([
      tx.request.count({ where: openRequestWhere }),
      // Portal-Sicht: nur freigegebene & nicht soft-gelöschte Dokumente.
      tx.document.count({
        where: { clientId, deletedAt: null, sharedWithClientAt: { not: null } },
      }),
      tx.request.findMany({
        where: clientRequestWhere,
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, title: true, status: true, dueAt: true },
      }),
      // „Das brauchen wir von Ihnen": offene Anforderungen + offene Formulare.
      tx.request.findMany({
        where: openRequestWhere,
        select: { id: true, title: true, dueAt: true },
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: TODO_LIST_CAP,
      }),
      // Offen heißt wie unter /portal/forms: Formular PENDING/DRAFT UND seine
      // Anforderung noch offen. Die Kandidaten (wenige je Mandant) werden
      // vollständig geladen, damit Zähler und Liste dieselbe Regel nutzen.
      visibility.forms
        ? tx.formSubmission.findMany({
            where: { clientId, status: { in: [...PORTAL_FORM_OPEN_STATUSES] } },
            select: {
              id: true,
              status: true,
              requestId: true,
              template: { select: { name: true } },
              requests: {
                where: { tenantId, clientId },
                select: { id: true, status: true },
                orderBy: { id: 'asc' },
              },
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      // Offene Rechnungen (versendet / überfällig) — Mandant sieht sie im
      // Portal; hier als Überblick auf der Startseite.
      visibility.invoices
        ? tx.invoice.findMany({
            where: openInvoiceWhere,
            select: { id: true, number: true, dueDate: true, totalAmount: true, status: true },
            orderBy: { dueDate: 'asc' },
            take: OPEN_INVOICES_CAP,
          })
        : Promise.resolve([]),
      visibility.invoices ? tx.invoice.count({ where: openInvoiceWhere }) : Promise.resolve(0),
      clientInbox
        ? countPortalInboxNeedsClientTx(tx, { tenantId, clientId, contactId })
        : Promise.resolve(0),
      interactionKinds.length
        ? tx.clientInteraction.findMany({
            where: openInteractionWhere,
            select: { id: true, kind: true, snapshot: true, expiresAt: true },
            orderBy: { expiresAt: 'asc' },
            take: TODO_LIST_CAP,
          })
        : Promise.resolve([]),
      interactionKinds.length
        ? tx.clientInteraction.count({ where: openInteractionWhere })
        : Promise.resolve(0),
    ]);
  });
  const openForms = formCandidates.filter(isPortalFormOpen);
  return {
    visibility,
    openRequestCount,
    documentCount,
    recentRequests,
    todoRequests,
    openFormCount: openForms.length,
    todoForms: openForms.slice(0, TODO_LIST_CAP),
    openInvoices,
    openInvoiceCount,
    inboxNeedsClientCount,
    todoInteractions,
    openInteractionCount,
  };
}

export default async function PortalDashboardPage() {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');

  const { tenantId, contactId, clientId } = session.user;
  const ctx = { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' as const };
  const [modules, portalFeatures] = await Promise.all([readModules(ctx), readPortalFeatures(ctx)]);
  const {
    visibility,
    openRequestCount,
    documentCount,
    recentRequests,
    todoRequests,
    openFormCount,
    todoForms,
    openInvoices,
    openInvoiceCount,
    inboxNeedsClientCount,
    todoInteractions,
    openInteractionCount,
  } = await loadPortalDashboard(ctx, clientId, modules, portalFeatures.clientInbox);

  const todoCount = openRequestCount + openFormCount + openInteractionCount;
  const todoShown = todoRequests.length + todoForms.length + todoInteractions.length;

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
            {todoInteractions.map((interaction) => (
              <li
                key={`interaction-${interaction.id}`}
                className="px-6 py-3 flex items-center justify-between gap-3"
              >
                <Link
                  href="/portal/interactions"
                  className="flex items-center gap-3 min-w-0 hover:underline"
                >
                  <UserCheck className="h-4 w-4 text-brand-600 shrink-0" />
                  <span className="text-sm text-primary truncate">
                    {interactionTitle(interaction.kind, interaction.snapshot)}
                  </span>
                </Link>
                <span className="text-xs text-muted shrink-0">
                  Antwort bis {fmtDateShort(interaction.expiresAt)}
                </span>
              </li>
            ))}
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
        <TodoListFooter
          shown={todoShown}
          total={todoCount}
          links={[
            {
              href: '/portal/requests',
              label: 'Alle Anforderungen',
              more: openRequestCount > todoRequests.length,
            },
            {
              href: '/portal/forms',
              label: 'Alle Formulare',
              more: openFormCount > todoForms.length,
            },
            {
              href: '/portal/interactions',
              label: 'Alle Rückmeldungen',
              more: openInteractionCount > todoInteractions.length,
            },
          ]}
        />
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
              {openInvoiceCount > 0 && <span className="badge-yellow">{openInvoiceCount}</span>}
              {openInvoiceCount > openInvoices.length && (
                <span className="text-xs text-muted">
                  {openInvoices.length.toLocaleString('de-DE')} von{' '}
                  {openInvoiceCount.toLocaleString('de-DE')} angezeigt
                </span>
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

/** Hinweis „x von y angezeigt“ mit Links auf die vollständigen Listen. */
function TodoListFooter({
  shown,
  total,
  links,
}: {
  shown: number;
  total: number;
  links: ReadonlyArray<{ href: string; label: string; more: boolean }>;
}) {
  if (total <= shown) return null;
  return (
    <div className="card-footer">
      <span>
        {shown.toLocaleString('de-DE')} von {total.toLocaleString('de-DE')} angezeigt
      </span>
      <span className="flex flex-wrap items-center gap-3">
        {links
          .filter((link) => link.more)
          .map((link) => (
            <Link key={link.href} href={link.href} className="text-brand-700 hover:underline">
              {link.label}
            </Link>
          ))}
      </span>
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
