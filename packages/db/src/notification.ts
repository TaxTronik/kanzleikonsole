import type { NotificationKind } from '@prisma/client';

import type { TxClient } from './tenant-context';

export interface NotificationUpsertInput {
  tenantId: string;
  /** Persistierter Mandantenscope; bekannte resourceType/resourceId-Paare werden DB-seitig validiert. */
  clientId?: string | null;
  staffId?: string | null;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  href?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

export interface NotificationResourceRef {
  resourceType: string;
  resourceId: string;
}

export interface NotificationResolutionInput {
  tenantId: string;
  /** Fachliche Ressourcen, deren offener Hinweis erledigt ist. */
  resources?: readonly NotificationResourceRef[];
  /** Alt-/Nebenressourcen mit demselben Ziel werden darüber mit aufgelöst. */
  hrefs?: readonly string[];
  /** Optional auf bestimmte Ereignisarten begrenzen. */
  kinds?: readonly NotificationKind[];
  /** Optional nur Benachrichtigungen bestimmter Empfänger schließen. */
  staffIds?: readonly string[];
  /** Bewusste tenant-weite Recovery; nur zusammen mit `kinds` zulässig. */
  tenantWide?: boolean;
  resolvedAt?: Date;
}

export interface ClientContactNotificationResolutionInput {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  resolvedAt?: Date;
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

async function persistClientContactNotificationIfApplicable(
  tx: TxClient,
  input: NotificationUpsertInput,
  title: string,
  body: string | null,
): Promise<boolean> {
  const [actorContext] = await tx.$queryRaw<Array<{ actorType: string | null }>>`
    SELECT app.current_actor_type() AS "actorType"
  `;
  if (actorContext?.actorType !== 'CLIENT_CONTACT') return false;

  // Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001,
  // ACCESS-TENANT-RLS-001. Portal-Kontakte dürfen interne Staff-Hinweise
  // nicht SELECTen. Die DB-Funktion hält den Upsert deshalb write-only und
  // gibt weder Notification-ID noch Inhalt an den Portal-Kontext zurück.
  await tx.$queryRaw`
    SELECT app.upsert_client_contact_notification(
      ${input.tenantId}::uuid,
      ${input.clientId ?? null}::uuid,
      ${input.staffId ?? null}::uuid,
      ${input.kind}::public.notification_kind,
      ${title}::text,
      ${body}::text,
      ${input.href ?? null}::text,
      ${input.resourceType ?? null}::text,
      ${input.resourceId ?? null}::text
    )
  `;
  return true;
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
  if (await persistClientContactNotificationIfApplicable(tx, input, title, body)) return;

  const where = {
    tenantId: input.tenantId,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
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
      clientId: input.clientId ?? null,
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

/**
 * Eng begrenzter Portal-Pfad: CLIENT_CONTACT darf Staff-Notifications nicht
 * lesen. Die DB-Funktion prüft daher ausschließlich die aktuelle
 * Kontakt-/Mandantenzuordnung und markiert passende Ressourcenhinweise, ohne
 * deren Inhalt an den Portal-Actor zurückzugeben.
 */
export async function resolveClientContactNotificationsTx(
  tx: TxClient,
  input: ClientContactNotificationResolutionInput,
): Promise<number> {
  const resolvedAt = input.resolvedAt ?? new Date();
  const [result] = await tx.$queryRaw<Array<{ resolvedCount: number }>>`
    SELECT app.resolve_client_contact_notifications(
      ${input.tenantId}::uuid,
      ${input.resourceType}::text,
      ${input.resourceId}::text,
      ${resolvedAt}::timestamptz
    )::integer AS "resolvedCount"
  `;
  return result?.resolvedCount ?? 0;
}

/**
 * Schließt ungelesene Benachrichtigungen, sobald der zugrunde liegende
 * fachliche Vorgang erledigt wurde. Die Auflösung gehört in dieselbe
 * Transaktion wie der Statuswechsel, damit Aufgabe und Glocke nie auseinander
 * laufen.
 */
export async function resolveNotificationsTx(
  tx: TxClient,
  input: NotificationResolutionInput,
): Promise<number> {
  const resources = input.resources ?? [];
  const hrefs = [...new Set(input.hrefs ?? [])];
  const matches = [
    ...resources.map((resource) => ({
      resourceType: resource.resourceType,
      resourceId: resource.resourceId,
    })),
    ...hrefs.map((href) => ({ href })),
  ];
  const tenantWide = input.tenantWide === true && Boolean(input.kinds?.length);
  if (matches.length === 0 && !tenantWide) return 0;

  const result = await tx.notification.updateMany({
    where: {
      tenantId: input.tenantId,
      readAt: null,
      ...(matches.length ? { OR: matches } : {}),
      ...(input.kinds?.length ? { kind: { in: [...input.kinds] } } : {}),
      ...(input.staffIds?.length ? { staffId: { in: [...input.staffIds] } } : {}),
    },
    data: { readAt: input.resolvedAt ?? new Date() },
  });
  return result.count;
}
