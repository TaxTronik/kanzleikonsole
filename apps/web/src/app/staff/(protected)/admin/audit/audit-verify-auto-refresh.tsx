'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Nach „Jetzt prüfen" / Recovery-Checkpoint pollt diese Komponente nur den
 * kleinen Status-Endpunkt. Die komplette Seite wird erst aktualisiert, wenn
 * exakt der neu angestoßene Lauf persistiert wurde.
 */
export function AuditVerifyAutoRefresh({
  requestId,
}: {
  requestId?: string | null;
}) {
  const router = useRouter();
  const hasQueuedCheck = !!requestId;

  useEffect(() => {
    if (!hasQueuedCheck) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/staff/admin/audit/verify-status?requestId=${encodeURIComponent(requestId!)}`, {
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
      if (Date.now() - start > 300_000) return;
      timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasQueuedCheck, requestId, router]);
  return null;
}
