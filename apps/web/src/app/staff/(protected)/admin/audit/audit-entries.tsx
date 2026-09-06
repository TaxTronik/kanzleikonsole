import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fmtDateTimeSeconds } from '@/lib/fmt';
import { AUDIT_CATEGORIES, auditCategory } from '@/server/audit/query';
import type { AuditPageData } from './audit-page-data';
import { auditPagination, type AuditPageQuery } from './audit-page-state';

const actorTypeLabels: Record<string, string> = {
  STAFF: 'Mitarbeiter',
  CLIENT_CONTACT: 'Mandant',
  SYSTEM: 'System',
};

export function AuditEntries({
  entries,
  totalCount,
  filters,
  cursor,
}: {
  entries: AuditPageData['entries'];
  totalCount: number;
  filters: AuditPageQuery;
  cursor?: string;
}) {
  const { baseQs, query, hasFilter } = filters;
  const { visibleEntries, nextCursor, nextQs } = auditPagination(entries, baseQs);
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-3 border-b border-default flex items-center justify-between text-xs text-muted">
        <span>
          {hasFilter
            ? `${totalCount.toLocaleString('de-DE')} Treffer · zeige ${visibleEntries.length}`
            : `${totalCount.toLocaleString('de-DE')} Einträge gesamt · zeige ${visibleEntries.length}`}
        </span>
      </div>
      {visibleEntries.length === 0 ? (
        <p className="px-6 py-16 text-sm text-disabled text-center">Keine Einträge.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-default">
              <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                ID
              </th>
              <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                Zeit
              </th>
              <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                Akteur
              </th>
              <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                Action
              </th>
              <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                Ressource
              </th>
              <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                Hash
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {visibleEntries.map((e) => (
              <tr key={String(e.id)} className="hover:bg-gray-50">
                <td className="px-6 py-2 font-mono text-muted">
                  <Link
                    href={`/staff/admin/audit/${e.id}`}
                    className="hover:underline text-brand-700"
                  >
                    {String(e.id)}
                  </Link>
                </td>
                <td className="px-6 py-2 text-secondary whitespace-nowrap">
                  {fmtDateTimeSeconds(e.occurredAt)}
                </td>
                <td className="px-6 py-2 text-secondary whitespace-nowrap">
                  {actorTypeLabels[e.actorType] ?? e.actorType}
                </td>
                <td className="px-6 py-2 text-primary">
                  <span className="block font-mono whitespace-nowrap">{e.action}</span>
                  <span className="text-muted">{AUDIT_CATEGORIES[auditCategory(e.action)]}</span>
                </td>
                <td className="px-6 py-2 text-secondary font-mono whitespace-nowrap">
                  {e.resourceType}
                  {e.resourceId && (
                    <span className="text-disabled">:{e.resourceId.slice(0, 8)}</span>
                  )}
                </td>
                <td className="px-6 py-2 text-disabled font-mono break-all">
                  {Buffer.from(e.thisHash).toString('hex')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {/* Pagination-Footer */}
      <div className="card-footer">
        {cursor ? (
          <Link
            href={`/staff/admin/audit${baseQs.toString() ? '?' + baseQs.toString() : ''}`}
            className="text-brand-700 hover:underline flex items-center gap-1"
          >
            <ChevronLeft className="h-3 w-3" />
            Zur ersten Seite
          </Link>
        ) : (
          <span />
        )}
        {nextCursor ? (
          <Link
            href={`/staff/admin/audit?${nextQs.toString()}`}
            className="text-brand-700 hover:underline flex items-center gap-1"
          >
            {query.sort === 'oldest' ? 'Neuere Einträge' : 'Ältere Einträge'}
            <ChevronRight className="h-3 w-3" />
          </Link>
        ) : (
          <span className="text-disabled">Ende der Liste</span>
        )}
      </div>
    </div>
  );
}
