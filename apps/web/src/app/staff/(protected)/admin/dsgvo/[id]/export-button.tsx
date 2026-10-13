'use client';

// Welle 15 (Folgepunkt P-11): Das Kontaktpaket erzeugt der Worker
// dsgvo-export. Die Schaltfläche fordert es an; der Status (angefordert, läuft,
// fertig, fehlgeschlagen) kommt aus dem Auftrag, solange er offen ist, lädt die
// Seite alle fünf Sekunden neu. Der Download prüft Größe und SHA-256 serverseitig.

import { useEffect, useState, useTransition } from 'react';
import { Download } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { requestContactExportAction } from '../actions';

export type ExportJobStatus = 'REQUESTED' | 'RUNNING' | 'DONE' | 'FAILED';

export interface ExportJobView {
  status: ExportJobStatus;
  requestedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Offener Auftrag, der nicht mehr vorankommt (server/dsgvo/export-status). */
  stale: boolean;
  /** Fertiges, am Antrag gebundenes und noch abgelegtes Paket. */
  downloadable: boolean;
}

const STATUS_LABELS: Record<ExportJobStatus, string> = {
  REQUESTED: 'Angefordert — wartet auf die Hintergrundverarbeitung',
  RUNNING: 'Läuft',
  DONE: 'Fertig',
  FAILED: 'Fehlgeschlagen',
};

export const EXPORT_STATUS_REFRESH_MS = 5_000;

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

export function ExportContactButton({
  contactId,
  requestId,
  latest,
}: {
  contactId: string;
  requestId: string;
  latest: ExportJobView | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const active = (latest?.status === 'REQUESTED' || latest?.status === 'RUNNING') && !latest.stale;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), EXPORT_STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, router]);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const r = await requestContactExportAction(requestId, contactId);
      if (!r.ok) setError(r.error ?? 'Anforderung fehlgeschlagen.');
      router.refresh();
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleClick}
          disabled={isPending || active}
          className="btn-primary"
        >
          <Download className="h-4 w-4" />
          {isPending ? 'Wird angefordert…' : 'JSON-Auskunft anfordern'}
        </button>
        {latest?.downloadable && (
          <a href={`/api/staff/admin/dsgvo/${requestId}/export`} className="btn-secondary">
            <Download className="h-4 w-4" />
            Paket herunterladen
          </a>
        )}
      </div>
      {latest && (
        <p className="text-xs text-blue-900 mt-2" role="status">
          Letzter Auftrag: {STATUS_LABELS[latest.status]} · angefordert{' '}
          {fmtDateTime(latest.requestedAt)}
          {latest.stale && ' · reagiert nicht; eine neue Anforderung ersetzt ihn'}
          {latest.finishedAt && ` · beendet ${fmtDateTime(latest.finishedAt)}`}
          {latest.error && ` · ${latest.error}`}
        </p>
      )}
      {error && <p className="text-xs text-red-700 mt-2">{error}</p>}
    </>
  );
}
