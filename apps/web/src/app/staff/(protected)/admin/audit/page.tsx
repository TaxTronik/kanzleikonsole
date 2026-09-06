// /staff/admin/audit — authorized tenant reads, then read-only view composition.
import { FileDown } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';
import { AuditVerifyAutoRefresh } from './audit-verify-auto-refresh';
import { AuditAnchorAutoRefresh } from './audit-anchor-auto-refresh';
import { AuditNotificationAcknowledger } from './audit-notification-acknowledger';
import { AuditAccessCard } from './audit-access-card';
import { AuditChainStatusCard } from './audit-chain-status';
import { AuditEntries } from './audit-entries';
import { AuditFilters } from './audit-filters';
import { RollingAnchorCard } from './rolling-anchor-card';
import { loadAuditPageData } from './audit-page-data';
import {
  parseAuditPageQuery,
  shouldPollAuditVerify,
  auditOkResultKey,
  type SearchParams,
} from './audit-page-state';

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireStaffPage({ admin: true });
  const sp = await searchParams;
  const { tenantId, staffId } = session.user;
  const filters = parseAuditPageQuery(sp);
  const data = await loadAuditPageData(tenantId, staffId, filters);
  const { verifyResult, checkpoint, anchorSummary, anchorStatus } = data;
  const pendingAnchorCount = Number(anchorSummary.pending_count);
  const pollVerify = shouldPollAuditVerify(sp, verifyResult);

  return (
    <div className="p-8">
      <AuditNotificationAcknowledger resultKey={auditOkResultKey(verifyResult)} />
      <AuditAnchorAutoRefresh active={pendingAnchorCount > 0} />
      {pollVerify && <AuditVerifyAutoRefresh requestId={sp.requestId} queuedAt={sp.queuedAt} />}
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Audit-Log</h1>
          <p className="text-muted text-sm">
            Hash-verkettete Aufzeichnung aller compliance-relevanten Operationen.
          </p>
        </div>
        <a
          href={
            filters.valid ? '/api/staff/admin/audit/export?' + filters.baseQs.toString() : undefined
          }
          aria-disabled={!filters.valid}
          className="btn-secondary"
        >
          <FileDown className="h-4 w-4" />
          CSV exportieren
        </a>
      </div>
      <RollingAnchorCard
        summary={anchorSummary}
        status={anchorStatus}
        pendingCount={pendingAnchorCount}
      />
      <AuditAccessCard tenantId={tenantId} />
      <AuditChainStatusCard
        verifyResult={verifyResult}
        checkpoint={checkpoint}
        pollVerify={pollVerify}
        checkpointCreated={sp.checkpoint === 'created'}
      />
      <AuditFilters sp={sp} filters={filters} resourceTypeRows={data.resourceTypeRows} />
      <AuditEntries
        entries={data.entries}
        totalCount={data.totalCount}
        filters={filters}
        cursor={sp.cursor}
      />
    </div>
  );
}
