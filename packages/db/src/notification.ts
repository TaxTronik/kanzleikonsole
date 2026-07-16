import type { NotificationKind } from '@prisma/client';

import type { TxClient } from './tenant-context';

export interface NotificationUpsertInput {
  tenantId: string;
  staffId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

/**
 * Normalizes notification copy before it is persisted. Notifications are
 * rendered as text today, but keeping the stored value harmless protects
 * future renderers and every producer (web and worker) consistently.
 */
export function sanitizeNotificationText(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/</g, '‹')
  );
}

/**
 * Shared advisory-lock protected notification upsert. The lock closes the
 * find-first/create race without serializing unrelated notification keys.
 * Callers own the surrounding tenant transaction.
 */
export async function upsertNotificationTx(
  tx: TxClient,
  input: NotificationUpsertInput,
): Promise<void> {
  const title = sanitizeNotificationText(input.title);
  const body = input.body != null ? sanitizeNotificationText(input.body) : null;
  const where = {
    tenantId: input.tenantId,
    staffId: input.staffId ?? null,
    kind: input.kind,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    readAt: null,
  };

  const lockKey = `notify:${where.tenantId}:${where.staffId ?? ''}:${where.kind}:${where.resourceType ?? ''}:${where.resourceId ?? ''}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

  const existing = await tx.notification.findFirst({ where });
  if (existing) {
    await tx.notification.update({
      where: { id: existing.id },
      data: {
        title,
        body,
        href: input.href ?? null,
        createdAt: new Date(),
      },
    });
    return;
  }

  await tx.notification.create({
    data: {
      tenantId: input.tenantId,
      staffId: input.staffId ?? null,
      kind: input.kind,
      title,
      body,
      href: input.href ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
    },
  });
}
