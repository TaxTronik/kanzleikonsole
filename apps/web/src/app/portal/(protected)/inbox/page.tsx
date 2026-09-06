import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { MessageSquarePlus, Search } from 'lucide-react';
import { withTenantContext } from '@taxtronik/db';
import { portalAuth } from '@/server/auth/portal';
import { readPortalFeatures } from '@/server/settings/portal-features';
import { listPortalInboxThreadsTx, type InboxListFilters } from '@/server/inbox/queries';
import { INBOX_TOPICS, INBOX_TOPIC_LABELS, type InboxTopic } from '@/server/inbox/constants';
import { OffsetPagination } from '@/components/offset-pagination';
import { fmtDateTimeShort } from '@/lib/fmt';

function topic(value: string | undefined): InboxTopic | undefined {
  return INBOX_TOPICS.find((candidate) => candidate === value);
}

export default async function PortalInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await portalAuth();
  if (!session?.user) redirect('/portal/login');
  const { tenantId, clientId, contactId } = session.user;
  const ctx = { tenantId, actorId: contactId, actorType: 'CLIENT_CONTACT' as const };
  const features = await readPortalFeatures(ctx);
  if (!features.clientInbox) notFound();
  const raw = await searchParams;
  const page = Number(raw.page ?? '1');
  const filters: InboxListFilters = {
    page,
    query: raw.q,
    topic: topic(raw.topic),
    status: raw.status === 'OPEN' || raw.status === 'RESOLVED' ? raw.status : undefined,
    attention:
      raw.attention === 'STAFF' || raw.attention === 'CLIENT' || raw.attention === 'NONE'
        ? raw.attention
        : undefined,
  };
  const data = await withTenantContext(ctx, (tx) =>
    listPortalInboxThreadsTx(tx, { tenantId, clientId, contactId }, filters),
  );
  const baseQs = new URLSearchParams();
  if (raw.q) baseQs.set('q', raw.q);
  if (filters.topic) baseQs.set('topic', filters.topic);
  if (filters.status) baseQs.set('status', filters.status);
  if (filters.attention) baseQs.set('attention', filters.attention);

  return (
    <main className="p-4 sm:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary">Nachrichten</h1>
          <p className="mt-1 text-sm text-muted">
            Sicherer, asynchroner Austausch mit Ihrer Kanzlei.
          </p>
        </div>
        <Link href="/portal/inbox/new" className="btn-primary inline-flex items-center gap-2">
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          Nachricht an Kanzlei
        </Link>
      </div>

      <form
        method="get"
        className="card mb-5 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5"
        role="search"
      >
        <label className="sm:col-span-2">
          <span className="sr-only">Betreff oder Mandantenmetadaten durchsuchen</span>
          <span className="relative block">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted"
              aria-hidden="true"
            />
            <input
              className="input w-full pl-9"
              name="q"
              defaultValue={raw.q}
              placeholder="Betreff suchen"
              maxLength={120}
            />
          </span>
        </label>
        <label>
          <span className="sr-only">Thema</span>
          <select className="input w-full" name="topic" defaultValue={filters.topic ?? ''}>
            <option value="">Alle Themen</option>
            {INBOX_TOPICS.map((value) => (
              <option key={value} value={value}>
                {INBOX_TOPIC_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Status</span>
          <select className="input w-full" name="status" defaultValue={filters.status ?? ''}>
            <option value="">Alle Status</option>
            <option value="OPEN">Offen</option>
            <option value="RESOLVED">Erledigt</option>
          </select>
        </label>
        <button className="btn-secondary" type="submit">
          Filtern
        </button>
      </form>

      <section className="card overflow-hidden" aria-label="Nachrichtenverläufe">
        {data.items.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <MessageSquarePlus
              className="mx-auto mb-3 h-12 w-12 text-disabled"
              aria-hidden="true"
            />
            <p className="text-sm text-disabled">Keine passenden Nachrichten vorhanden.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {data.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/portal/inbox/${item.id}`}
                  className="block p-4 hover:bg-gray-50 sm:px-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="break-words font-medium text-primary">{item.subject}</span>
                        {item.unread ? <span className="badge-brand">Neu</span> : null}
                        {item.status === 'RESOLVED' ? (
                          <span className="badge-gray">Erledigt</span>
                        ) : null}
                        {item.attention === 'CLIENT' && item.status === 'OPEN' ? (
                          <span className="badge-yellow">Antwort von Ihnen benötigt</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted">{INBOX_TOPIC_LABELS[item.topic]}</p>
                    </div>
                    <time
                      className="shrink-0 text-xs text-muted"
                      dateTime={item.lastMessageAt.toISOString()}
                    >
                      {fmtDateTimeShort(item.lastMessageAt)}
                    </time>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <OffsetPagination
          basePath="/portal/inbox"
          baseQs={baseQs}
          page={data.page}
          pageSize={data.pageSize}
          totalCount={data.total}
        />
      </section>
    </main>
  );
}
