import Link from 'next/link';
import { AUDIT_CATEGORIES } from '@/server/audit/query';
import type { SearchParams, AuditPageQuery } from './audit-page-state';

export function AuditFilters({
  sp,
  filters,
  resourceTypeRows,
}: {
  sp: SearchParams;
  filters: AuditPageQuery;
  resourceTypeRows: { resourceType: string }[];
}) {
  return (
    <>
      {/* Filter */}
      {filters.error && (
        <p role="alert" className="alert-error-sm mb-4">
          Ungültige Filter: {filters.error}
        </p>
      )}
      <p className="text-xs text-muted mb-3">
        Filter betreffen nur die Anzeige und den CSV-Auszug. Der Prüfstatus gilt für die
        vollständige Kanzlei-Kette; ein gefilterter Auszug ist kein lückenloses Kettenarchiv.
      </p>
      <form
        action="/staff/admin/audit"
        method="get"
        className="card p-4 mb-6 grid grid-cols-2 md:grid-cols-5 gap-3"
      >
        <div>
          <label className="label" htmlFor="category">
            Bereich
          </label>
          <select
            id="category"
            name="category"
            className="input text-xs"
            defaultValue={sp.category ?? ''}
          >
            <option value="">Alle Bereiche</option>
            {Object.entries(AUDIT_CATEGORIES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sort">
            Kettenfolge
          </label>
          <select id="sort" name="sort" className="input text-xs" defaultValue={filters.query.sort}>
            <option value="newest">Neueste zuerst</option>
            <option value="oldest">Älteste zuerst</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="action">
            Action
          </label>
          <input
            id="action"
            name="action"
            type="text"
            className="input text-xs"
            placeholder="z. B. document.upload"
            defaultValue={sp.action ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="actorType">
            Akteur
          </label>
          <select
            id="actorType"
            name="actorType"
            className="input text-xs"
            defaultValue={sp.actorType ?? ''}
          >
            <option value="">Alle</option>
            <option value="STAFF">Mitarbeiter</option>
            <option value="CLIENT_CONTACT">Mandant</option>
            <option value="SYSTEM">System</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="resourceType">
            Ressource
          </label>
          <select
            id="resourceType"
            name="resourceType"
            className="input text-xs"
            defaultValue={sp.resourceType ?? ''}
          >
            <option value="">Alle</option>
            {resourceTypeRows.map((r) => (
              <option key={r.resourceType} value={r.resourceType}>
                {r.resourceType}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="from">
            Von
          </label>
          <input
            id="from"
            name="from"
            type="date"
            className="input text-xs"
            defaultValue={sp.from ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="to">
            Bis
          </label>
          <input
            id="to"
            name="to"
            type="date"
            className="input text-xs"
            defaultValue={sp.to ?? ''}
          />
        </div>
        <div className="col-span-2 md:col-span-5 flex gap-2">
          <button type="submit" className="btn-primary text-xs">
            Filtern
          </button>
          <Link href="/staff/admin/audit" className="btn-secondary text-xs">
            Zurücksetzen
          </Link>
        </div>
      </form>
    </>
  );
}
