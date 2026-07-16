// =============================================================================
// Notification-Service
//
// Erzeugt In-App-Notifications. Für staffId=null gilt die Notification
// "an alle Mitarbeiter" (UI filtert dann auf staffId IS NULL OR staffId = me).
//
// Idempotenz-Schutz: pro (tenantId, kind, resourceType, resourceId, staffId)
// wird nur EINE ungelesene Notification angelegt — Folge-Events updaten den
// Timestamp statt neu zu inserten.
// =============================================================================

import type { NotificationKind } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { upsertNotificationTx } from '@taxtronik/db/notification';

interface NotifyInput {
  tenantId: string;
  staffId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

export async function notify(tx: TxClient, input: NotifyInput): Promise<void> {
  await upsertNotificationTx(tx, input);
}

/**
 * Massenerstellung an mehrere Mitarbeiter (für rollen-basierte Notifications,
 * z. B. „GwG-Beauftragter"). Für staffIds=[null] = an alle.
 */
export async function notifyMany(
  tx: TxClient,
  staffIds: Array<string | null>,
  input: Omit<NotifyInput, 'staffId'>,
): Promise<void> {
  await Promise.all(staffIds.map((sid) => notify(tx, { ...input, staffId: sid })));
}
