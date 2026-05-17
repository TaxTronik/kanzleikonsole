// =============================================================================
// /staff/admin/audit/[id] — Audit-Log-Eintrag Detail
//
// Zeigt:
//   - alle Header-Felder
//   - vorher/nachher als kombinierter Diff (rot=entfernt, grün=neu)
//   - Hash + Vorgänger-Hash mit lokalem Recompute zur Verifikation des
//     einzelnen Eintrags ("intakt" wenn computed == this_hash)
//   - Vorheriger/Nächster-Eintrag (per id)
// =============================================================================

import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ChevronLeft, ChevronRight, ShieldCheck, ShieldAlert } from 'lucide-react';
import { createHash } from 'node:crypto';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { canonicalJson } from '@taxtronik/evidence';

const actorTypeLabels: Record<string, string> = {
  STAFF: 'Mitarbeiter',
  CLIENT_CONTACT: 'Mandant',
  SYSTEM: 'System',
};

export default async function AuditEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }

  const { id } = await params;
  let entryId: bigint;
  try {
    entryId = BigInt(id);
  } catch {
    notFound();
  }
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const entry = await tx.auditLog.findFirst({ where: { id: entryId } });
      if (!entry) return null;
      const [prev, next] = await Promise.all([
        tx.auditLog.findFirst({
          where: { id: { lt: entry.id } },
          orderBy: { id: 'desc' },
          select: { id: true },
        }),
        tx.auditLog.findFirst({
          where: { id: { gt: entry.id } },
          orderBy: { id: 'asc' },
          select: { id: true },
        }),
      ]);
      return { entry, prev, next };
    },
  );

  if (!data) notFound();
  const { entry, prev, next } = data;

  // Lokale Verifikation: Hash neu berechnen
  const canonical = {
    tenantId: entry.tenantId,
    occurredAt: entry.occurredAt.toISOString(),
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  };
  const computed = createHash('sha256')
    .update(Buffer.from(entry.prevHash))
    .update(Buffer.from(canonicalJson(canonical), 'utf8'))
    .digest();
  const intact = computed.equals(Buffer.from(entry.thisHash));

  const beforeStr = entry.before ? JSON.stringify(entry.before, null, 2) : null;
  const afterStr = entry.after ? JSON.stringify(entry.after, null, 2) : null;
  const diffLines = beforeStr || afterStr ? renderDiff(beforeStr, afterStr) : [];

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/admin/audit" className="text-gray-400 hover:text-gray-600 mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">Audit-Eintrag #{String(entry.id)}</h1>
            {intact ? (
              <span className="badge-green flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" />
                Hash verifiziert
              </span>
            ) : (
              <span className="badge-red flex items-center gap-1">
                <ShieldAlert className="h-3 w-3" />
                Hash-Mismatch!
              </span>
            )}
          </div>
          <p className="text-gray-500 text-sm font-mono">
            {entry.action} · {entry.resourceType}
            {entry.resourceId ? `:${entry.resourceId}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {prev && (
            <Link
              href={`/staff/admin/audit/${prev.id}`}
              className="btn-secondary text-xs py-1.5"
              title="Vorheriger Eintrag"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Älter
            </Link>
          )}
          {next && (
            <Link
              href={`/staff/admin/audit/${next.id}`}
              className="btn-secondary text-xs py-1.5"
              title="Nächster Eintrag"
            >
              Neuer
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>

      {/* Header-Felder */}
      <div className="card p-6 mb-6">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div>
            <dt className="text-xs text-gray-500 uppercase tracking-wide">Zeitpunkt</dt>
            <dd className="text-gray-900 font-mono">
              {new Intl.DateTimeFormat('de-DE', {
                dateStyle: 'short',
                timeStyle: 'medium',
              }).format(entry.occurredAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 uppercase tracking-wide">Akteur</dt>
            <dd className="text-gray-900">
              {actorTypeLabels[entry.actorType] ?? entry.actorType}
              {entry.actorId && (
                <span className="text-gray-500 font-mono ml-2 text-xs">{entry.actorId.slice(0, 12)}…</span>
              )}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-gray-500 uppercase tracking-wide">Quelle</dt>
            <dd className="text-gray-700 text-xs">
              {entry.ip && <span className="font-mono">IP: {entry.ip}</span>}
              {entry.ip && entry.userAgent && ' · '}
              {entry.userAgent && <span className="font-mono break-all">{entry.userAgent}</span>}
              {!entry.ip && !entry.userAgent && <span className="text-gray-400">—</span>}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-xs text-gray-500 uppercase tracking-wide">Hash-Chain</dt>
            <dd className="text-xs font-mono space-y-1 mt-1">
              <p>
                <span className="text-gray-500">prev:</span>{' '}
                <span className="text-gray-700">{Buffer.from(entry.prevHash).toString('hex')}</span>
              </p>
              <p>
                <span className="text-gray-500">this:</span>{' '}
                <span className={intact ? 'text-green-700' : 'text-red-700'}>
                  {Buffer.from(entry.thisHash).toString('hex')}
                </span>
              </p>
              {!intact && (
                <p>
                  <span className="text-gray-500">computed:</span>{' '}
                  <span className="text-yellow-700">{computed.toString('hex')}</span>
                </p>
              )}
            </dd>
          </div>
        </dl>
      </div>

      {/* Diff */}
      <div className="card overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-900">Änderungs-Diff</h2>
          <div className="flex gap-2 text-xs">
            <span className="badge-red">- vorher</span>
            <span className="badge-green">+ nachher</span>
          </div>
        </div>
        {diffLines.length === 0 ? (
          <p className="px-6 py-10 text-sm text-gray-400 text-center">
            Keine vorher/nachher-Daten.
          </p>
        ) : (
          <pre className="px-6 py-4 text-xs font-mono overflow-x-auto leading-relaxed">
            {diffLines.map((l, i) => (
              <div
                key={i}
                className={
                  l.kind === 'add'
                    ? 'bg-green-50 text-green-900'
                    : l.kind === 'del'
                      ? 'bg-red-50 text-red-900'
                      : 'text-gray-700'
                }
              >
                <span className="inline-block w-5 text-gray-400 select-none">
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                </span>
                {l.text}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

interface DiffLine {
  kind: 'add' | 'del' | 'eq';
  text: string;
}

/**
 * Naiver line-based Diff: zeilenweise vergleichen, alle gemeinsamen
 * Präfix/Suffix-Linien als 'eq', der Rest als del/add. Funktioniert gut für
 * JSON-pretty-print (das wir hier nutzen).
 */
function renderDiff(before: string | null, after: string | null): DiffLine[] {
  const beforeLines = (before ?? '').split('\n');
  const afterLines = (after ?? '').split('\n');

  // gemeinsamer Präfix
  let head = 0;
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) {
    head++;
  }
  // gemeinsamer Suffix
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail++;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: 'eq', text: beforeLines[i] ?? '' });
  for (let i = head; i < beforeLines.length - tail; i++) out.push({ kind: 'del', text: beforeLines[i] ?? '' });
  for (let i = head; i < afterLines.length - tail; i++) out.push({ kind: 'add', text: afterLines[i] ?? '' });
  for (let i = beforeLines.length - tail; i < beforeLines.length; i++) {
    out.push({ kind: 'eq', text: beforeLines[i] ?? '' });
  }
  return out;
}
