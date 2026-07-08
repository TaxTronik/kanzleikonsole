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
      // Race-Serialisierung je Dedupe-Key (siehe notifications/service.ts):
      // schließt die findFirst-then-create-Lücke auch für Kinds ohne
      // Daily-Dedupe-Index (dort feuert P2002 nie). Transaktionsgebunden,
      // blockiert nur identische Keys.
      const lockKey = `notify:${tenantId}:${staffId}:${data.kind}:${data.resourceType}:${data.resourceId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
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
