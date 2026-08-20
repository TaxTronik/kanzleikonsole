'use client';

import { useEffect } from 'react';
import { emitNotificationsChanged } from '@/lib/live-events';
import { acknowledgeAuditOkNotificationAction } from './actions';

export function AuditNotificationAcknowledger({ resultKey }: { resultKey: string | null }) {
  useEffect(() => {
    if (!resultKey) return;
    void acknowledgeAuditOkNotificationAction().then((result) => {
      if (result.ok && result.resolved && result.resolved > 0) {
        emitNotificationsChanged();
      }
    });
  }, [resultKey]);

  return null;
}
