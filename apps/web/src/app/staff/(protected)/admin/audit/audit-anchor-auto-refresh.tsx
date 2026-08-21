'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const REFRESH_WINDOW_MS = 60_000;

/** Refreshes only while a newly committed local tail is waiting for its TSA anchor. */
export function AuditAnchorAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= REFRESH_WINDOW_MS) {
        clearInterval(timer);
        return;
      }
      if (document.visibilityState === 'visible') router.refresh();
    }, 2_000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}
