// =============================================================================
// /staff/admin/archive — Audit-Archiv-Übersicht
// =============================================================================

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Archive, ShieldCheck } from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import { fmtDateTimeShort } from '@/lib/fmt';


export default async function AuditArchivePage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }
  const { tenantId, staffId } = session.user;

  const data = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
      const [archives, lastEntry] = await Promise.all([
        tx.auditArchive.findMany({
          orderBy: { fromAuditId: 'desc' },
          take: 50,
        }),
        tx.auditLog.findFirst({
          orderBy: { id: 'desc' },
          select: { id: true },
        }),
      ]);
      const totalArchived = archives.reduce((s, a) => s + a.entryCount, 0);
      const totalBytes = archives.reduce((s, a) => s + Number(a.fileSizeBytes), 0);
      const lastArchivedTo = archives[0]?.toAuditId ?? BigInt(0);
      const pendingCount = lastEntry ? Number(lastEntry.id - lastArchivedTo) : 0;
      return { archives, totalArchived, totalBytes, pendingCount };
    },
  );

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-start gap-4 mb-6">
        <Link href="/staff/admin" className="text-disabled hover:text-secondary mt-1">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div className="flex-1">
          <h1 className="page-title">
            <Archive className="h-6 w-6 text-brand-600" />
            Audit-Archiv
          </h1>
          <p className="text-muted text-sm">
            Segmentweise ausgelagerte Audit-Log-Einträge — hash-versiegelt
            und mit Object-Lock COMPLIANCE für 10 Jahre in SeaweedFS gespeichert. Die Rotation
            läuft vom Worker automatisch (wöchentlich, sobald Einträge älter als 90 Tage sind).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="card p-4">
          <p className="text-xs text-muted uppercase">Archiv-Segmente</p>
          <p className="text-3xl font-bold text-primary mt-1">{data.archives.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted uppercase">Archivierte Einträge</p>
          <p className="text-3xl font-bold text-primary mt-1">{data.totalArchived.toLocaleString('de-DE')}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-muted uppercase">Im DB-Log offen</p>
          <p className="text-3xl font-bold text-primary mt-1">{data.pendingCount.toLocaleString('de-DE')}</p>
          <p className="text-xs text-disabled mt-1">noch nicht archiviert</p>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-3 border-b border-default text-xs text-muted flex items-center justify-between">
          <span>{data.archives.length} Segmente · {(data.totalBytes / 1024 / 1024).toFixed(2)} MB gesamt</span>
          <span>Verifizieren via <code>pnpm verify:chain</code></span>
        </div>
        {data.archives.length === 0 ? (
          <p className="px-6 py-16 text-sm text-disabled text-center">
            Noch keine Archive — Rotation läuft erst, wenn Einträge älter als 90 Tage existieren.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Segment</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Einträge</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Zeitraum</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Größe</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Modus</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-muted uppercase">Datei-SHA-256</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {data.archives.map((a) => (
                <tr key={String(a.id)} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-mono text-xs text-secondary">
                    #{String(a.fromAuditId)}–{String(a.toAuditId)}
                  </td>
                  <td className="px-6 py-3 text-secondary">{a.entryCount.toLocaleString('de-DE')}</td>
                  <td className="px-6 py-3 text-xs text-secondary">
                    {fmtDateTimeShort(a.fromOccurredAt)}
                    <br />
                    <span className="text-disabled">bis</span> {fmtDateTimeShort(a.toOccurredAt)}
                  </td>
                  <td className="px-6 py-3 text-secondary text-xs">
                    {(Number(a.fileSizeBytes) / 1024).toFixed(1)} KB
                  </td>
                  <td className="px-6 py-3">
                    {a.mode === 'SOFT' ? (
                      <span className="badge-gray">SOFT (DB-Backup)</span>
                    ) : (
                      <span className="badge-yellow">HARD (DB bereinigt)</span>
                    )}
                  </td>
                  <td className="px-6 py-3 font-mono text-[10px] text-disabled">
                    {Buffer.from(a.fileSha256).toString('hex').slice(0, 16)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-disabled mt-4 flex items-center gap-2">
        <ShieldCheck className="h-3 w-3" />
        Jedes Segment ist als NDJSON-Datei in SeaweedFS archiviert (Object-Lock
        COMPLIANCE 10 Jahre); bei konfigurierter TSA zusätzlich mit
        RFC-3161-Zeitstempel versehen. Die <code>verify:chain</code>-CLI prüft bei
        jedem Lauf die Datei-Integrität gegen die Hash-Anker.
      </p>
    </div>
  );
}
