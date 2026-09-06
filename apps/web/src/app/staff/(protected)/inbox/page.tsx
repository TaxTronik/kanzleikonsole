import Link from 'next/link';
import { MessageSquare, Search } from 'lucide-react';
import { withTenantContext } from '@taxtronik/db';
import { staffActionGuard } from '@/server/actions/staff-action';
import { requireStaffPage } from '@/server/auth/staff-page';
import { listStaffInboxThreadsTx } from '@/server/inbox/queries';
import { INBOX_TOPICS, INBOX_TOPIC_LABELS, type InboxTopic } from '@/server/inbox/constants';
import { OffsetPagination } from '@/components/offset-pagination';
import { fmtDateTimeShort } from '@/lib/fmt';

function topic(value: string | undefined): InboxTopic | undefined {
  return INBOX_TOPICS.find((candidate) => candidate === value);
}

export default async function StaffInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireStaffPage();
  const guard = await staffActionGuard({ requirePermission: 'PORTAL_INBOX_MANAGE' });
  if (!guard.ok)
    return (
      <p role="alert" className="alert-error-sm">
        {guard.error}
      </p>
    );
  const raw = await searchParams;
  const scope = raw.scope === 'team' || raw.scope === 'all' ? raw.scope : 'mine';
  const filters = {
    page: Number(raw.page ?? '1'),
    query: raw.q,
    topic: topic(raw.topic),
    status: raw.status === 'OPEN' || raw.status === 'RESOLVED' ? raw.status : undefined,
    attention:
      raw.attention === 'STAFF' || raw.attention === 'CLIENT' || raw.attention === 'NONE'
        ? raw.attention
        : undefined,
    scope,
  } as const;
  const data = await withTenantContext(guard.ctx, (tx) =>
    listStaffInboxThreadsTx(tx, guard.session, filters),
  );
  const baseQs = new URLSearchParams();
  if (raw.q) baseQs.set('q', raw.q);
  if (filters.topic) baseQs.set('topic', filters.topic);
  if (filters.status) baseQs.set('status', filters.status);
  if (filters.attention) baseQs.set('attention', filters.attention);
  if (scope !== 'mine') baseQs.set('scope', scope);

  return (
    <main className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-primary">Mandantenpost</h1>
        <p className="mt-1 text-sm text-muted">
          Nachrichten und noch zu klassifizierende Anlagen aus dem Mandantenportal.
        </p>
      </header>

      <nav className="flex gap-2" aria-label="Arbeitsbereich">
        {(['mine', 'team', 'all'] as const).map((value) => {
          const qs = new URLSearchParams(baseQs);
          qs.delete('page');
          if (value === 'mine') qs.delete('scope');
          else qs.set('scope', value);
          return (
            <Link
              key={value}
              href={`/staff/inbox${qs.size ? `?${qs}` : ''}`}
              className={scope === value ? 'btn-primary' : 'btn-secondary'}
              aria-current={scope === value ? 'page' : undefined}
            >
              {value === 'mine' ? 'Meine Arbeit' : value === 'team' ? 'Team' : 'Alle'}
            </Link>
          );
        })}
      </nav>

      <form
        method="get"
        role="search"
        className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5"
      >
        {scope !== 'mine' ? <input type="hidden" name="scope" value={scope} /> : null}
        <label className="sm:col-span-2">
          <span className="sr-only">Betreff oder Mandant durchsuchen</span>
          <span className="relative block">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted"
              aria-hidden="true"
            />
            <input
              className="input w-full pl-9"
              name="q"
              defaultValue={raw.q}
              placeholder="Betreff oder Mandant"
              maxLength={120}
            />
          </span>
        </label>
        <select
          className="input"
          name="topic"
          aria-label="Thema"
          defaultValue={filters.topic ?? ''}
        >
          <option value="">Alle Themen</option>
          {INBOX_TOPICS.map((value) => (
            <option key={value} value={value}>
              {INBOX_TOPIC_LABELS[value]}
            </option>
          ))}
        </select>
        <select
          className="input"
          name="status"
          aria-label="Status"
          defaultValue={filters.status ?? ''}
        >
          <option value="">Alle Status</option>
          <option value="OPEN">Offen</option>
          <option value="RESOLVED">Erledigt</option>
        </select>
        <button className="btn-secondary">Filtern</button>
      </form>

      <section className="card overflow-hidden" aria-label="Mandantenpost-Verläufe">
        {data.items.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <MessageSquare className="mx-auto mb-3 h-12 w-12 text-disabled" aria-hidden="true" />
            <p className="text-sm text-disabled">Keine passenden Verläufe.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {data.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/staff/inbox/${item.id}`}
                  className="block p-4 hover:bg-gray-50 sm:px-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="break-words text-primary">{item.subject}</strong>
                        {item.attention === 'STAFF' && item.status === 'OPEN' ? (
                          <span className="badge-yellow">Kanzlei am Zug</span>
                        ) : null}
                        {item.status === 'RESOLVED' ? (
                          <span className="badge-gray">Erledigt</span>
                        ) : null}
                        {item.pendingAttachmentCount ? (
                          <span className="badge-purple">
                            {item.pendingAttachmentCount} Anlage
                            {item.pendingAttachmentCount === 1 ? '' : 'n'} prüfen
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {item.clientName} · {INBOX_TOPIC_LABELS[item.topic]} ·{' '}
                        {item.assignedStaffName ?? 'Teamkorb'}
                      </p>
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
          basePath="/staff/inbox"
          baseQs={baseQs}
          page={data.page}
          pageSize={data.pageSize}
          totalCount={data.total}
        />
      </section>
    </main>
  );
}
