'use client';

import { useState, useTransition } from 'react';
import { updateNoticeStatusAction } from './actions';

const STATUS_LABELS: Record<string, string> = {
  NEU: 'Neu',
  GEPRUEFT: 'Geprüft',
  EINSPRUCH: 'Einspruch eingelegt',
  ABGEHOLFEN: 'Abgeholfen',
  TEILABHILFE: 'Teilabhilfe',
  ZURUECKGEWIESEN: 'Zurückgewiesen',
  KLAGE: 'Klage erhoben',
  RECHTSKRAEFTIG: 'Rechtskräftig',
};

/**
 * Quick-Action im Bescheid-Postfach: Status-Transition über ein kompaktes
 * Select (nur die jeweils erlaubten Folge-Status). Ab GEPRUEFT erscheint der
 * Bescheid im Mandantenportal.
 */
export function NoticeStatusSelect({ noticeId, allowed }: { noticeId: string; allowed: string[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (allowed.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 mt-1">
      <select
        className="input text-xs py-1"
        value=""
        disabled={pending}
        aria-label="Bescheid-Status ändern"
        onChange={(e) => {
          const status = e.target.value;
          if (!status) return;
          setError(null);
          start(async () => {
            const r = await updateNoticeStatusAction({ noticeId, status });
            if (!r.ok) setError(r.error ?? 'Fehler beim Statuswechsel.');
          });
        }}
      >
        <option value="">{pending ? 'Speichere…' : 'Status ändern…'}</option>
        {allowed.map((s) => (
          <option key={s} value={s}>
            → {STATUS_LABELS[s] ?? s}
          </option>
        ))}
      </select>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
