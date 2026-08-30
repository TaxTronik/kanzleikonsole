'use client';

import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import { fmtDateTimeShort } from '@/lib/fmt';
import type { N8nRecentDeliveryView, N8nSetupStatus } from '@/server/n8n/status';
import type { ActionResult } from './n8n-actions';
import { N8nActionResult } from './n8n-form-result';

interface DeliveryOperationsSectionProps {
  status: N8nSetupStatus;
  failedDeliveries: N8nRecentDeliveryView[];
  failedCursor: string | null;
  hasMoreFailedDeliveries: boolean;
  deliveryOperationResult: ActionResult | null;
  retryResult: Record<string, ActionResult>;
  replayResult: Record<string, ActionResult>;
  busy: boolean;
  saving: boolean;
  onReplayUnroutedEvent: (eventId: string, eventName: string, occurredAt: string) => void;
  onSkipUnroutedEvent: (eventId: string, eventName: string) => void;
  onRetryDelivery: (deliveryId: string, targetUrl: string) => void;
  onAcknowledgeDelivery: (deliveryId: string) => void;
  onLoadMoreFailedDeliveries: () => void;
}

export function DeliveryOperationsSection({
  status,
  failedDeliveries,
  failedCursor,
  hasMoreFailedDeliveries,
  deliveryOperationResult,
  retryResult,
  replayResult,
  busy,
  saving,
  onReplayUnroutedEvent,
  onSkipUnroutedEvent,
  onRetryDelivery,
  onAcknowledgeDelivery,
  onLoadMoreFailedDeliveries,
}: DeliveryOperationsSectionProps) {
  const visibleDeliveries = useMemo(() => {
    const seen = new Set<string>();
    return [...failedDeliveries, ...status.recentDeliveries].filter((delivery) => {
      if (seen.has(delivery.id)) return false;
      seen.add(delivery.id);
      return true;
    });
  }, [failedDeliveries, status.recentDeliveries]);

  return (
    <section className="space-y-4">
      {status.deliveryCounts.failed > 0 && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-xs text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100">
          <p className="font-semibold">
            {status.deliveryCounts.failed} offene fehlgeschlagene Zustellung(en)
          </p>
          <p className="mt-1">
            Offene Fehler stehen immer zuerst in der Tabelle und können seitenweise vollständig
            geladen werden. Ist das gespeicherte Ziel noch aktuell, kann erneut zugestellt werden;
            veraltete oder bewusst verworfene Fehler lassen sich ohne Versand revisionsprotokolliert
            quittieren.
          </p>
        </div>
      )}
      <N8nActionResult result={deliveryOperationResult} />
      {status.unroutedEvents.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-semibold">Events ohne aktive Route</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {status.unroutedEvents.map((item) => (
              <code key={item.event} className="rounded bg-white/70 px-2 py-1 dark:bg-black/20">
                {item.event} ({item.count})
              </code>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            {status.recentUnroutedEvents.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white/60 px-2 py-1.5 dark:border-amber-900 dark:bg-black/20"
              >
                <span>
                  <code>{item.event}</code>{' '}
                  <span className="text-amber-800 dark:text-amber-200">
                    {fmtDateTimeShort(new Date(item.occurredAt))}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy || saving}
                    onClick={() => onReplayUnroutedEvent(item.id, item.event, item.occurredAt)}
                  >
                    Jetzt zuordnen
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={busy || saving}
                    onClick={() => onSkipUnroutedEvent(item.id, item.event)}
                  >
                    Nicht senden
                  </button>
                  <N8nActionResult result={replayResult[item.id]} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-default">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="bg-surface-raised text-muted">
            <tr>
              <th className="px-3 py-2">Zeit</th>
              <th className="px-3 py-2">Event</th>
              <th className="px-3 py-2">Workflow</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Versuche</th>
              <th className="px-3 py-2">Diagnose</th>
              <th className="px-3 py-2">Aktion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {visibleDeliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td className="px-3 py-2 text-muted">
                  {fmtDateTimeShort(new Date(delivery.createdAt))}
                </td>
                <td className="px-3 py-2">
                  <code title={`Event-ID ${delivery.eventId}\nDelivery-ID ${delivery.id}`}>
                    {delivery.event}
                  </code>
                </td>
                <td className="px-3 py-2 text-primary">
                  <span className="block">{delivery.endpoint}</span>
                  <code
                    className="block max-w-[260px] truncate text-[10px] text-muted"
                    title={delivery.targetUrl}
                  >
                    {delivery.targetUrl || 'kein HTTP-Ziel'}
                  </code>
                </td>
                <td className="px-3 py-2">
                  <DeliveryState status={delivery.status} />
                </td>
                <td className="px-3 py-2 text-muted">{delivery.attempts}</td>
                <td
                  className="max-w-[280px] truncate px-3 py-2 text-muted"
                  title={delivery.lastError ?? undefined}
                >
                  {delivery.httpStatus
                    ? `HTTP ${delivery.httpStatus}`
                    : (delivery.lastError ??
                      (delivery.latencyMs != null ? `${delivery.latencyMs} ms` : '—'))}
                </td>
                <td className="px-3 py-2">
                  {delivery.status === 'FAILED' && (
                    <span className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy || saving || !delivery.targetUrl}
                        onClick={() => onRetryDelivery(delivery.id, delivery.targetUrl)}
                      >
                        Erneut versuchen
                      </button>
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={busy || saving}
                        onClick={() => onAcknowledgeDelivery(delivery.id)}
                      >
                        Quittieren
                      </button>
                    </span>
                  )}
                  <N8nActionResult result={retryResult[delivery.id]} />
                </td>
              </tr>
            ))}
            {visibleDeliveries.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-muted">
                  Noch keine Zustellungen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hasMoreFailedDeliveries && (
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={busy || saving || !failedCursor}
          onClick={onLoadMoreFailedDeliveries}
        >
          Weitere fehlgeschlagene Zustellungen laden
        </button>
      )}
    </section>
  );
}

function DeliveryState({ status }: { status: N8nRecentDeliveryView['status'] }) {
  if (status === 'DELIVERED')
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> zugestellt
      </span>
    );
  if (status === 'FAILED')
    return (
      <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400">
        <AlertCircle className="h-3 w-3" /> fehlgeschlagen
      </span>
    );
  if (status === 'SKIPPED') return <span className="text-muted">übersprungen</span>;
  if (status === 'PROCESSING')
    return (
      <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" /> wird zugestellt
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-muted">
      <Loader2 className="h-3 w-3" /> wartend
    </span>
  );
}
