// =============================================================================
// Gemeinsamer Notification-Upsert für Worker-Jobs.
//
// Atomar pro Tenant (withWorkerTenantContext → RLS + Audit-Context). Idempotent
// über (tenantId, staffId, kind, resourceType, resourceId, readAt=null): ein
// Folge-Event aktualisiert die bestehende ungelesene Notification statt eine
// zweite anzulegen. P2002 vom Daily-Dedupe-Index wird als „bereits geschrieben"
// interpretiert (Race zwischen Scheduler-Tick und manuellem Trigger).
// =============================================================================

import type { NotificationKind } from '@prisma/client';
import { upsertNotificationTx } from '@taxtronik/db/notification';
import { Prisma } from '@taxtronik/db/prisma-client';
import { withWorkerTenantContext } from './tenant-context';

export interface NotifyData {
  kind: NotificationKind;
  title: string;
  body: string;
  href: string;
  resourceType: string;
  resourceId: string;
}

export async function upsertNotification(
  tenantId: string,
  staffId: string,
  data: NotifyData,
): Promise<void> {
  try {
    await withWorkerTenantContext(tenantId, async (tx) => {
      await upsertNotificationTx(tx, { tenantId, staffId, ...data });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Idempotenz-Index hat eine parallele Notification bereits persistiert.
      return;
    }
    throw err;
  }
}
