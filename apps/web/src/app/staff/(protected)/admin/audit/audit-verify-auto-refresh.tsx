'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Nach „Jetzt prüfen" / Recovery-Checkpoint (URL-Param verify=queued) pollt
 * diese Komponente router.refresh(), bis der Worker das neue Prüfergebnis
 * persistiert hat — sodass die Seite das Ergebnis ohne manuelles Neuladen
 * anzeigt. Bricht nach 5 min ab (Worker nicht erreichbar/hängt).
 */
export function AuditVerifyAutoRefresh({
  requestId,
  resultRequestId,
}: {
  requestId?: string | null;
  resultRequestId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hasQueuedCheck = !!requestId;
  const hasFreshResult = !!requestId && resultRequestId === requestId;

  useEffect(() => {
    if (!hasFreshResult) return;

    const qs = new URLSearchParams(searchParams.toString());
    qs.delete('verify');
    qs.delete('requestId');
    const next = qs.toString() ? `${pathname}?${qs.toString()}` : pathname;
    router.replace(next, { scroll: false });
  }, [hasFreshResult, pathname, router, searchParams]);

  useEffect(() => {
    if (!hasQueuedCheck || hasFreshResult) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();
    const tick = (): void => {
      if (stopped) return;
      router.refresh();
      if (Date.now() - start > 300_000) return;
      timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasFreshResult, hasQueuedCheck, router]);
  return null;
}
