import { ShieldCheck, ShieldAlert, Clock3 } from 'lucide-react';
import type { PersistedAnchorStatus } from '@taxtronik/evidence';
import { fmtDateTimeSeconds } from '@/lib/fmt';
import type { AnchorSummary } from './audit-page-data';

function anchorPresentation(
  summary: AnchorSummary,
  status: PersistedAnchorStatus | null,
  pendingCount: number,
) {
  const delayed = status?.state === 'DELAYED' || status?.state === 'LOCAL_ONLY';
  const hasAnchor = summary.last_anchored_audit_id !== null;
  if (delayed || (hasAnchor && summary.trust_anchored !== true)) {
    return {
      Icon: ShieldAlert,
      iconClass: 'text-yellow-600',
      cardClass:
        'rounded-md border border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-800 dark:bg-yellow-950/50',
    };
  }
  if (pendingCount > 0) {
    return {
      Icon: Clock3,
      iconClass: 'text-muted',
      cardClass:
        'rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/50',
    };
  }
  if (hasAnchor && summary.trust_anchored === true) {
    return {
      Icon: ShieldCheck,
      iconClass: 'text-green-600',
      cardClass:
        'rounded-md border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950/50',
    };
  }
  return { Icon: Clock3, iconClass: 'text-muted', cardClass: 'card p-4' };
}

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
  const hasAnchor = summary.last_anchored_audit_id !== null;
  const { Icon, iconClass, cardClass } = anchorPresentation(summary, status, pendingCount);
  return (
    <section className={cardClass} aria-labelledby="external-audit-anchor-title">
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${iconClass}`} aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="external-audit-anchor-title" className="text-sm font-medium text-primary">
            Externe Rolling-Verankerung
          </h2>
          {hasAnchor ? (
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
          ) : hasAnchor ? (
            <p className="text-xs text-secondary mt-1">Kein unverankerter lokaler Restbestand.</p>
          ) : null}
          {status?.state === 'LOCAL_ONLY' && (
            <p className="text-xs text-yellow-800 mt-1 dark:text-yellow-100">
              Zeitstempel-Modus: lokal. Es wird derzeit kein externer TSA-Nachweis erstellt.
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
    </section>
  );
}
