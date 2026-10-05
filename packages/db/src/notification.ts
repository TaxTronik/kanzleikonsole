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

type NotificationKeyFields = Pick<
  NotificationUpsertInput,
  'tenantId' | 'staffId' | 'kind' | 'resourceType' | 'resourceId'
>;

/** Advisory-Lock-Schlüssel eines Benachrichtigungsschlüssels (ohne Mandantenscope). */
function notificationLockKey(input: NotificationKeyFields): string {
  return `notify:${input.tenantId}:${input.staffId ?? ''}:${input.kind}:${input.resourceType ?? ''}:${input.resourceId ?? ''}`;
}

/** Suchbedingung einer Benachrichtigung; `clientId` nur, wenn der Producer ihn setzt. */
function notificationKeyWhere(input: NotificationUpsertInput) {
  return {
    tenantId: input.tenantId,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    staffId: input.staffId ?? null,
    kind: input.kind,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
  };
}

function notificationCreateData(
  input: NotificationUpsertInput,
  title: string,
  body: string | null,
) {
  return {
    tenantId: input.tenantId,
    clientId: input.clientId ?? null,
    staffId: input.staffId ?? null,
    kind: input.kind,
    title,
    body,
    href: input.href ?? null,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
  };
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

  const where = { ...notificationKeyWhere(input), readAt: null };

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${notificationLockKey(input)}, 0))`;

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

  await tx.notification.create({ data: notificationCreateData(input, title, body) });
}

/** Ergebnis der gebündelten Worker-Pfade (R-11). */
export interface NotificationBatchResult {
  /** Neu angelegte Benachrichtigungen. */
  created: number;
  /** Aktualisierte ungelesene Benachrichtigungen desselben Schlüssels. */
  updated: number;
}

/** Statements je Abschnitt: Sperren, Bestandsabfrage und Neuanlagen. */
const NOTIFICATION_BATCH_SIZE = 250;

interface PreparedNotification {
  input: NotificationUpsertInput;
  title: string;
  body: string | null;
  lockKey: string;
}

/**
 * Sanitizer für jeden Eintrag; mehrfach übergebene Schlüssel zählen einmal mit
 * der letzten Eingabe (wie nacheinander ausgeführte Upserts). Sortiert nach
 * Lock-Schlüssel, damit überlappende Läufe in derselben Folge sperren.
 */
function prepareNotifications(inputs: readonly NotificationUpsertInput[]): PreparedNotification[] {
  const byIdentity = new Map<string, PreparedNotification>();
  for (const input of inputs) {
    const lockKey = notificationLockKey(input);
    const scope = input.clientId === undefined ? '*' : (input.clientId ?? '-');
    byIdentity.set(`${lockKey}:${scope}`, {
      input,
      title: sanitizeNotificationText(input.title),
      body: input.body != null ? sanitizeNotificationText(input.body) : null,
      lockKey,
    });
  }
  return [...byIdentity.values()].sort((a, b) =>
    a.lockKey < b.lockKey ? -1 : a.lockKey > b.lockKey ? 1 : 0,
  );
}

/**
 * Die gebündelten Pfade schreiben direkt in `notification`. Portal-Kontakte
 * dürfen das nicht (write-only DB-Funktion, siehe upsertNotificationTx).
 */
async function assertBatchActor(tx: TxClient): Promise<void> {
  const [actorContext] = await tx.$queryRaw<Array<{ actorType: string | null }>>`
    SELECT app.current_actor_type() AS "actorType"
  `;
  if (actorContext?.actorType === 'CLIENT_CONTACT') {
    throw new Error(
      'NOTIFICATION_BATCH_CLIENT_CONTACT: im Portal-Kontext upsertNotificationTx verwenden',
    );
  }
}

async function upsertNotificationChunkTx(
  tx: TxClient,
  chunk: readonly PreparedNotification[],
): Promise<NotificationBatchResult> {
  const lockKeys = [...new Set(chunk.map((entry) => entry.lockKey))];
  // unnest liefert die (sortierten) Schlüssel in Array-Reihenfolge.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(lock_key, 0))
      FROM unnest(${lockKeys}::text[]) AS lock_key
  `;
  const existing = await tx.notification.findMany({
    where: { readAt: null, OR: chunk.map((entry) => notificationKeyWhere(entry.input)) },
    select: {
      id: true,
      tenantId: true,
      clientId: true,
      staffId: true,
      kind: true,
      resourceType: true,
      resourceId: true,
    },
  });
  const existingByLockKey = new Map<string, typeof existing>();
  for (const row of existing) {
    const key = notificationLockKey(row);
    existingByLockKey.set(key, [...(existingByLockKey.get(key) ?? []), row]);
  }

  let updated = 0;
  const toCreate: Array<ReturnType<typeof notificationCreateData>> = [];
  for (const entry of chunk) {
    const match = existingByLockKey
      .get(entry.lockKey)
      ?.find(
        (row) =>
          entry.input.clientId === undefined || row.clientId === (entry.input.clientId ?? null),
      );
    if (!match) {
      toCreate.push(notificationCreateData(entry.input, entry.title, entry.body));
      continue;
    }
    await tx.notification.update({
      where: { id: match.id },
      data: {
        title: entry.title,
        body: entry.body,
        href: entry.input.href ?? null,
        createdAt: new Date(),
      },
    });
    updated += 1;
  }
  // Konflikt mit einem Tages-Dedupe-Index = heute bereits geschrieben (und
  // inzwischen gelesen): überspringen statt die Transaktion abzubrechen.
  const created =
    toCreate.length > 0
      ? (await tx.notification.createMany({ data: toCreate, skipDuplicates: true })).count
      : 0;
  return { created, updated };
}

/**
 * R-11: gebündelte Variante von upsertNotificationTx für Worker-Producer.
 * Je Eintrag gilt dieselbe Semantik — Sanitizer, Advisory-Lock je Schlüssel,
 * eine ungelesene Benachrichtigung desselben Schlüssels wird aktualisiert
 * statt dupliziert —, aber Sperren, Bestandsabfrage und Neuanlagen laufen je
 * Abschnitt gebündelt. Abweichend vom Einzel-Upsert überspringt die Neuanlage
 * Konflikte mit den Tages-Dedupe-Indizes, statt die Transaktion abzubrechen.
 */
export async function upsertNotificationsTx(
  tx: TxClient,
  inputs: readonly NotificationUpsertInput[],
): Promise<NotificationBatchResult> {
  const result: NotificationBatchResult = { created: 0, updated: 0 };
  if (inputs.length === 0) return result;
  await assertBatchActor(tx);
  const prepared = prepareNotifications(inputs);
  for (let offset = 0; offset < prepared.length; offset += NOTIFICATION_BATCH_SIZE) {
    const chunk = await upsertNotificationChunkTx(
      tx,
      prepared.slice(offset, offset + NOTIFICATION_BATCH_SIZE),
    );
    result.created += chunk.created;
    result.updated += chunk.updated;
  }
  return result;
}

/**
 * R-11: legt jede Eingabe neu an (mit Sanitizer) — für tägliche Erinnerungen,
 * deren Wiederholung pro UTC-Tag die Tages-Dedupe-Indizes begrenzen: ein
 * Konflikt wird übersprungen. Liefert die Zahl neu angelegter Zeilen.
 */
export async function insertNotificationsTx(
  tx: TxClient,
  inputs: readonly NotificationUpsertInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  await assertBatchActor(tx);
  let created = 0;
  for (let offset = 0; offset < inputs.length; offset += NOTIFICATION_BATCH_SIZE) {
    const data = inputs
      .slice(offset, offset + NOTIFICATION_BATCH_SIZE)
      .map((input) =>
        notificationCreateData(
          input,
          sanitizeNotificationText(input.title),
          input.body != null ? sanitizeNotificationText(input.body) : null,
        ),
      );
    created += (await tx.notification.createMany({ data, skipDuplicates: true })).count;
  }
  return created;
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
