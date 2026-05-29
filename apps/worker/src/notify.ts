// =============================================================================
// Gemeinsamer Notification-Upsert für Worker-Jobs.
//
// Atomar pro Tenant (withWorkerTenantContext → RLS + Audit-Context). Idempotent
// über (tenantId, staffId, kind, resourceType, resourceId, readAt=null): ein
// Folge-Event aktualisiert die bestehende ungelesene Notification statt eine
// zweite anzulegen. P2002 vom Daily-Dedupe-Index wird als „bereits geschrieben"
// interpretiert (Race zwischen Scheduler-Tick und manuellem Trigger).
// =============================================================================

import { Prisma, type NotificationKind } from '@prisma/client';
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
      const existing = await tx.notification.findFirst({
        where: {
          tenantId,
          staffId,
          kind: data.kind,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
          readAt: null,
        },
      });
      if (existing) {
        await tx.notification.update({
          where: { id: existing.id },
          data: { title: data.title, body: data.body, href: data.href, createdAt: new Date() },
        });
        return;
      }
      await tx.notification.create({
        data: {
          tenantId,
          staffId,
          kind: data.kind,
          title: data.title,
          body: data.body,
          href: data.href,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Idempotenz-Index hat eine parallele Notification bereits persistiert.
      return;
    }
    throw err;
  }
}
