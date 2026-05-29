// =============================================================================
// /staff/admin/audit — Audit-Log-Viewer
//
// Cursor-basierte Pagination (höchste id zuerst, älter via cursor).
// Filter: action-Pattern, actor-Type, resource-Type, von/bis-Datum.
// Zeigt Hash-Chain-Status oben (verifiziert oder gebrochen).
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck, ShieldAlert, ChevronLeft, ChevronRight, FileDown } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { evidenceService } from '@/server/container';
import type { Prisma } from '@prisma/client';
import { fmtDateTimeSeconds } from '@/lib/fmt';

const PAGE_SIZE = 50;

const actorTypeLabels: Record<string, string> = {
  STAFF: 'Mitarbeiter',
  CLIENT_CONTACT: 'Mandant',
  SYSTEM: 'System',
};

interface SearchParams {
  cursor?: string;
  action?: string;
  actorType?: string;
  resourceType?: string;
  from?: string;
  to?: string;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }

  const sp = await searchParams;
  const { tenantId, staffId } = session.user;

  const where: Prisma.AuditLogWhereInput = {};
  if (sp.action) where.action = { contains: sp.action, mode: 'insensitive' };
  if (sp.actorType && ['STAFF', 'CLIENT_CONTACT', 'SYSTEM'].includes(sp.actorType)) {
    where.actorType = sp.actorType as 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM';
  }
  if (sp.resourceType) where.resourceType = sp.resourceType;
  if (sp.from || sp.to) {
    where.occurredAt = {};
    if (sp.from) where.occurredAt.gte = new Date(sp.from);
    if (sp.to) {
      const to = new Date(sp.to);
      to.setHours(23, 59, 59, 999);
      where.occurredAt.lte = to;
    }
  }
  if (sp.cursor) {
    try {
      where.id = { lt: BigInt(sp.cursor) };
    } catch {
      // ignore
    }
  }

  const [entries, totalCount, chainResult] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { id: 'desc' },
          take: PAGE_SIZE + 1,
        }),
        tx.auditLog.count({ where }),
        evidenceService.verifyChain(tx, tenantId).catch(() => null),
      ]),
  );

  const hasNext = entries.length > PAGE_SIZE;
  const visibleEntries = entries.slice(0, PAGE_SIZE);
  const nextCursor = hasNext ? String(visibleEntries[visibleEntries.length - 1]!.id) : null;

  // Distinct resource_types für Filter-Dropdown
  const resourceTypes = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    (tx) =>
      tx.auditLog.findMany({
        select: { resourceType: true },
        distinct: ['resourceType'],
        orderBy: { resourceType: 'asc' },
      }),
  );

  // Filter-Query-String für Pagination-Links
  const baseQs = new URLSearchParams();
  if (sp.action) baseQs.set('action', sp.action);
  if (sp.actorType) baseQs.set('actorType', sp.actorType);
  if (sp.resourceType) baseQs.set('resourceType', sp.resourceType);
  if (sp.from) baseQs.set('from', sp.from);
  if (sp.to) baseQs.set('to', sp.to);
  const nextQs = new URLSearchParams(baseQs);
  if (nextCursor) nextQs.set('cursor', nextCursor);

  return (
    <div className="p-8">
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Audit-Log</h1>
          <p className="text-muted text-sm">
            Hash-verkettete Aufzeichnung aller compliance-relevanten Operationen.
          </p>
        </div>
        <a
          href={`/api/staff/admin/audit/export${baseQs.toString() ? '?' + baseQs.toString() : ''}`}
          className="btn-secondary"
        >
          <FileDown className="h-4 w-4" />
          CSV exportieren
        </a>
      </div>

      {/* Hash-Chain-Status */}
      <div
        className={
          chainResult?.ok
            ? 'rounded-md border border-green-200 bg-green-50 p-4 mb-6'
            : 'rounded-md border border-red-200 bg-red-50 p-4 mb-6'
        }
      >
        <div className="flex items-start gap-3">
          {chainResult?.ok ? (
            <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-red-600 mt-0.5" />
          )}
          <div className="flex-1">
            {chainResult?.ok ? (
              <>
                <p className="text-sm font-medium text-green-900">
                  Hash-Chain intakt — {chainResult.checked} Einträge geprüft
                </p>
                <p className="text-xs text-green-700 mt-1">
                  {chainResult.sealsChecked} Tagesversiegelungen geprüft
                  {chainResult.sealBreaks.length > 0
                    ? ` · ${chainResult.sealBreaks.length} mit TSA-Problem`
                    : ''}
                </p>
              </>
            ) : chainResult ? (
              <>
                <p className="text-sm font-medium text-red-900">
                  ⚠ Hash-Chain gebrochen!
                </p>
                {chainResult.firstBreak && (
                  <p className="text-xs text-red-700 mt-1 font-mono">
                    Erster Bruch bei Audit-ID {String(chainResult.firstBreak.auditId)} (
                    {fmtDateTimeSeconds(chainResult.firstBreak.occurredAt,)}
                    )
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-secondary">Verifikation fehlgeschlagen.</p>
            )}
          </div>
        </div>
      </div>

      {/* Filter */}
      <form action="/staff/admin/audit" method="get" className="card p-4 mb-6 grid grid-cols-2 md:grid-cols-5 gap-3">
        <div>
          <label className="label" htmlFor="action">Action</label>
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
          <label className="label" htmlFor="actorType">Akteur</label>
          <select id="actorType" name="actorType" className="input text-xs" defaultValue={sp.actorType ?? ''}>
            <option value="">Alle</option>
            <option value="STAFF">Mitarbeiter</option>
            <option value="CLIENT_CONTACT">Mandant</option>
            <option value="SYSTEM">System</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="resourceType">Ressource</label>
          <select id="resourceType" name="resourceType" className="input text-xs" defaultValue={sp.resourceType ?? ''}>
            <option value="">Alle</option>
            {resourceTypes.map((r) => (
              <option key={r.resourceType} value={r.resourceType}>{r.resourceType}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="from">Von</label>
          <input id="from" name="from" type="date" className="input text-xs" defaultValue={sp.from ?? ''} />
        </div>
        <div>
          <label className="label" htmlFor="to">Bis</label>
          <input id="to" name="to" type="date" className="input text-xs" defaultValue={sp.to ?? ''} />
        </div>
        <div className="col-span-2 md:col-span-5 flex gap-2">
          <button type="submit" className="btn-primary text-xs">Filtern</button>
          <Link href="/staff/admin/audit" className="btn-secondary text-xs">Zurücksetzen</Link>
        </div>
      </form>

      {/* Tabelle */}
      <div className="card overflow-hidden">
        <div className="px-6 py-3 border-b border-default flex items-center justify-between text-xs text-muted">
          <span>{totalCount.toLocaleString('de-DE')} Treffer · zeige {visibleEntries.length}</span>
        </div>
        {visibleEntries.length === 0 ? (
          <p className="px-6 py-16 text-sm text-disabled text-center">Keine Einträge.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">ID</th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">Zeit</th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">Akteur</th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">Action</th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">Ressource</th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleEntries.map((e) => (
                <tr key={String(e.id)} className="hover:bg-gray-50">
                  <td className="px-6 py-2 font-mono text-muted">
                    <Link href={`/staff/admin/audit/${e.id}`} className="hover:underline text-brand-700">
                      {String(e.id)}
                    </Link>
                  </td>
                  <td className="px-6 py-2 text-secondary whitespace-nowrap">
                    {fmtDateTimeSeconds(e.occurredAt)}
                  </td>
                  <td className="px-6 py-2 text-secondary whitespace-nowrap">
                    {actorTypeLabels[e.actorType] ?? e.actorType}
                  </td>
                  <td className="px-6 py-2 font-mono text-primary whitespace-nowrap">{e.action}</td>
                  <td className="px-6 py-2 text-secondary font-mono whitespace-nowrap">
                    {e.resourceType}
                    {e.resourceId && (
                      <span className="text-disabled">:{e.resourceId.slice(0, 8)}</span>
                    )}
                  </td>
                  <td className="px-6 py-2 text-disabled font-mono">
                    {Buffer.from(e.thisHash).toString('hex').slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Pagination-Footer */}
        <div className="card-footer">
          {sp.cursor ? (
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
              Ältere Einträge
              <ChevronRight className="h-3 w-3" />
            </Link>
          ) : (
            <span className="text-disabled">Ende der Liste</span>
          )}
        </div>
      </div>
    </div>
  );
}
