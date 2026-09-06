import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { PersistedAnchorStatus } from '@taxtronik/evidence';
import { fmtDateTimeSeconds } from '@/lib/fmt';
import type { AnchorSummary } from './audit-page-data';

/** Dual-stamping status; kept separate from the already large log page. */
export function RollingAnchorCard({
  summary,
  status,
  pendingCount,
}: {
  summary: AnchorSummary;
  status: PersistedAnchorStatus | null;
  pendingCount: number;
}) {
  const delayed = status?.state === 'DELAYED' || status?.state === 'LOCAL_ONLY';
  const cardClass = delayed
    ? 'rounded-md border border-yellow-300 bg-yellow-50 p-4 mb-6 dark:border-yellow-800 dark:bg-yellow-950/50'
    : pendingCount > 0
      ? 'rounded-md border border-blue-200 bg-blue-50 p-4 mb-6 dark:border-blue-800 dark:bg-blue-950/50'
      : 'rounded-md border border-green-200 bg-green-50 p-4 mb-6 dark:border-green-800 dark:bg-green-950/50';
  return (
    <div className={cardClass}>
      <div className="flex items-start gap-3">
        {pendingCount === 0 && summary.last_anchored_audit_id ? (
          <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
        ) : (
          <ShieldAlert className="h-5 w-5 text-yellow-600 mt-0.5" />
        )}
        <div>
          <p className="text-sm font-medium text-primary">Externe Rolling-Verankerung</p>
          {summary.last_anchored_audit_id ? (
            <p className="text-xs text-secondary mt-1">
              RFC-3161-verankert bis Audit-ID {String(summary.last_anchored_audit_id)}
              {summary.tsa_gen_time && <> · TSA-Zeit {fmtDateTimeSeconds(summary.tsa_gen_time)}</>}
              {' · '}
              {summary.trust_anchored ? 'Trust-verankert' : 'Trust-Anchor fehlt'}
            </p>
          ) : (
            <p className="text-xs text-secondary mt-1">
              Noch kein externer Rolling-Anker vorhanden.
            </p>
          )}
          {pendingCount > 0 ? (
            <p className="text-xs text-blue-800 mt-1 dark:text-blue-100">
              {pendingCount} lokal verkettete{' '}
              {pendingCount === 1 ? 'Änderung wartet' : 'Änderungen warten'} auf den nächsten
              TSA-Checkpoint. Neue Einträge bleiben währenddessen möglich.
              {summary.oldest_pending_at && (
                <> Ältester offener Eintrag: {fmtDateTimeSeconds(summary.oldest_pending_at)}.</>
              )}
            </p>
          ) : (
            <p className="text-xs text-green-700 mt-1 dark:text-green-200">
              Kein unverankerter lokaler Restbestand.
            </p>
          )}
          {status?.error && (
            <p className="text-xs text-yellow-800 mt-1 dark:text-yellow-100">
              Letzter TSA-Versuch verzögert: {status.error}
              {status.nextRetryAt && (
                <> · nächster Versuch {fmtDateTimeSeconds(new Date(status.nextRetryAt))}</>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
