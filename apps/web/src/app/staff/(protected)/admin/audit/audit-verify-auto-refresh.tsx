'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const POLL_TIMEOUT_MS = 300_000;

/**
 * Nach „Jetzt prüfen" / Recovery-Checkpoint pollt diese Komponente nur den
 * kleinen Status-Endpunkt. Die Seite wird aktualisiert, sobald ein Lauf NEUER
 * als der Trigger-Zeitpunkt (`queuedAt`) persistiert wurde — oder exakt die
 * angestoßene requestId. Läuft der Job nicht (Worker aus), zeigt die Komponente
 * nach `POLL_TIMEOUT_MS` einen sichtbaren Hinweis statt still aufzugeben.
 */
export function AuditVerifyAutoRefresh({
  requestId,
  queuedAt,
}: {
  requestId?: string | null;
  queuedAt?: string | null;
}) {
  const router = useRouter();
  const hasQueuedCheck = !!requestId;
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (!hasQueuedCheck) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();
    const params = new URLSearchParams({ requestId: requestId! });
    if (queuedAt) params.set('queuedAt', queuedAt);
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/staff/admin/audit/verify-status?${params.toString()}`, {
          cache: 'no-store',
        });
        if (res.ok) {
          const data = (await res.json()) as { done?: boolean };
          if (data.done) {
            router.refresh();
            return;
          }
        }
      } catch {
        // weiter pollen; die Seite bleibt im "angestoßen"-Zustand.
      }
      if (Date.now() - start > POLL_TIMEOUT_MS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasQueuedCheck, requestId, queuedAt, router]);

  if (!timedOut) return null;
  return (
    <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 mb-4 text-xs text-yellow-800">
      Es liegt noch kein neues Prüfergebnis vor. Läuft der Hintergrund-Dienst
      (Worker)? Lade die Seite später neu, um den aktuellen Stand zu sehen.
    </div>
  );
}
