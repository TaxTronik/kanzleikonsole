import Link from 'next/link';
import { withTenantContext } from '@taxtronik/db';
import { requireStaffPage } from '@/server/auth/staff-page';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import {
  controlFilters,
  CONTROL_STATES,
  CONTROL_STATE_LABELS,
  type ControlRow,
} from '@/server/gwg/control-list-model';
import { GwgControlListTooLargeError, loadGwgControlListTx } from '@/server/gwg/control-list';
import { PersonLinkForm } from './person-link-form';

export default async function GwgControlPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireStaffPage();
  const params = await searchParams;
  const filters = controlFilters(params);
  const page = Math.max(
    1,
    Number.parseInt(typeof params.page === 'string' ? params.page : '1', 10) || 1,
  );
  const data = await withTenantContext(
    { tenantId: session.user.tenantId, actorId: session.user.staffId, actorType: 'STAFF' },
    async (tx) => {
      const clients = await tx.client.findMany({
        where: { AND: [await accessibleClientsWhereFor(tx, session), { anonymizedAt: null }] },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 10_000,
      });
      try {
        return { clients, list: await loadGwgControlListTx(tx, session, filters), error: null };
      } catch (error) {
        if (!(error instanceof GwgControlListTooLargeError)) throw error;
        return { clients, list: null, error: error.message };
      }
    },
    { isolationLevel: 'RepeatableRead' },
  );
  const query = new URLSearchParams({
    q: filters.query,
    state: filters.state,
    clientId: filters.clientId,
  });
  const groups = new Map<string, ControlRow[]>();
  for (const row of data.list?.rows ?? []) {
    const entries = groups.get(row.groupId) ?? [];
    entries.push(row);
    groups.set(row.groupId, entries);
  }
  const pages = Math.max(1, Math.ceil(groups.size / 50));
  const currentPage = Math.min(page, pages);
  const visible = [...groups].slice((currentPage - 1) * 50, currentPage * 50);
  const pageUrl = (next: number) => `/staff/gwg?${query.toString()}&page=${next}`;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">GwG-Kontrollliste</h1>
          <p className="mt-2 text-sm text-muted">
            Aktueller, nicht vernichteter Prüfstand der für Sie sichtbaren Mandanten. Diese
            Arbeitsübersicht ist keine vollständige GwG-Akte.
          </p>
        </div>
        {data.list && (
          <a className="btn-primary" href={`/api/staff/gwg/export?${query.toString()}`}>
            Excel exportieren
          </a>
        )}
      </div>
      <form className="card grid gap-4 p-4 md:grid-cols-4" method="get">
        <div>
          <label className="label" htmlFor="gwg-search">
            Person / Mandant / DATEV-Nr.
          </label>
          <input
            id="gwg-search"
            className="input"
            name="q"
            defaultValue={filters.query}
            maxLength={150}
          />
        </div>
        <div>
          <label className="label" htmlFor="gwg-state">
            Kontrollstatus
          </label>
          <select id="gwg-state" className="input" name="state" defaultValue={filters.state}>
            {CONTROL_STATES.map((state) => (
              <option key={state} value={state}>
                {state === 'ALL'
                  ? 'Alle'
                  : state === 'OPEN'
                    ? 'Alle offenen Punkte'
                    : CONTROL_STATE_LABELS[state]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="gwg-client">
            Mandant
          </label>
          <select id="gwg-client" className="input" name="clientId" defaultValue={filters.clientId}>
            <option value="">Alle sichtbaren Mandanten</option>
            {data.clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <button className="btn-secondary">Filtern</button>
        </div>
      </form>
      {data.error && (
        <p role="alert" className="alert-error-sm">
          {data.error}
        </p>
      )}
      {data.list && (
        <>
          <p className="text-sm text-muted">
            {groups.size} sichtbare Personengruppen · {data.list.rows.length} Detailzeilen. Beide
            Excel-Blätter verwenden dieselbe Personengruppennummer.
          </p>
          <PersonLinkForm people={data.list.people} links={data.list.links} />
          {!visible.length && <p className="card p-6 text-muted">Keine passenden Einträge.</p>}
          {visible.map(([id, rows]) => (
            <details key={id} className="card" open={visible.length <= 3}>
              <summary className="cursor-pointer p-4 font-medium">
                {id} · {[...new Set(rows.map((row) => row.personName))].join(' / ')}{' '}
                <span className="text-sm font-normal text-muted">
                  · {new Set(rows.map((row) => row.clientId)).size} sichtbare Mandanten
                </span>
              </summary>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-y border-subtle">
                      {[
                        'Mandant / Rolle',
                        'Ausweis',
                        'Kontrollstatus',
                        'Ausweisprüfung',
                        'GwG-Freigabe',
                      ].map((title) => (
                        <th className="p-3 font-medium" key={title}>
                          {title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.rowId} className="border-b border-subtle align-top">
                        <td className="p-3">
                          <Link
                            className="text-brand-700 underline"
                            href={`/staff/clients/${row.clientId}/gwg`}
                          >
                            {row.clientName}
                          </Link>
                          <p className="text-xs text-muted">
                            {row.roles.join(', ') || 'Keine Person erfasst'}
                          </p>
                          <p className="text-xs text-muted">
                            {row.personName}
                            {row.datevNo ? ` · DATEV ${row.datevNo}` : ''}
                          </p>
                        </td>
                        <td className="p-3">
                          <p>{row.documentType || 'Kein Ausweis'}</p>
                          <p className="font-mono">{row.number || 'Nummer fehlt'}</p>
                          <p className="text-xs text-muted">
                            {row.expiryDate ? `Gültig bis ${row.expiryDate}` : 'Gültigkeit fehlt'}
                          </p>
                        </td>
                        <td className="p-3">
                          {row.missingPerson
                            ? 'Keine Person erfasst'
                            : CONTROL_STATE_LABELS[row.state]}
                          <p className="text-xs text-muted">Prüfstatus: {row.checkStatus}</p>
                        </td>
                        <td className="p-3">
                          {row.identityReviewedBy || 'Nicht geprüft'}
                          <p className="text-xs text-muted">{row.identityReviewedAt}</p>
                        </td>
                        <td className="p-3">
                          {row.approvedBy || 'Nicht freigegeben'}
                          <p className="text-xs text-muted">{row.approvedAt}</p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
          {pages > 1 && (
            <nav aria-label="Kontrollliste Seiten" className="flex items-center justify-between">
              {currentPage > 1 ? (
                <Link className="btn-secondary" href={pageUrl(currentPage - 1)}>
                  Zurück
                </Link>
              ) : (
                <span />
              )}
              <span>
                Seite {currentPage} von {pages}
              </span>
              {currentPage < pages ? (
                <Link className="btn-secondary" href={pageUrl(currentPage + 1)}>
                  Weiter
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </div>
  );
}
