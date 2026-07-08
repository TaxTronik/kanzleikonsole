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

/**
 * Q-8: Defense-in-Depth-Sanitization für Notification-Title/-Body. Eingaben
 * stammen häufig aus user-controlled Ressourcen (Phone-Note-Subject, Request-
 * Message-Body, Mandanten-Eingaben). Heute werden Notifications in der React-
 * UI via Text-Interpolation gerendert (sicher) und in Mails via Markdown-
 * Renderer escaped — beides sicher. Wer aber später eine zusätzliche Mail-
 * Pipeline ohne Escape baut oder die UI mit dangerouslySetInnerHTML rendert,
 * darf nicht stillschweigend XSS-Bühne haben. Daher hier:
 *   - Control-Characters und Zero-Width-Joiner raus
 *   - HTML-Tag-Sequenzen `<` werden zu `‹` (Unicode-U+2039) entschärft.
 * Bewusst KEIN HTML-Encoding (`&lt;`), weil sonst die React-Text-Anzeige
 * `&lt;` als Literal anzeigt — wir wollen lesbar bleiben, ohne ein Tag-
 * Parser zu sein.
 */
function sanitizeText(s: string): string {
  return s
    // Control characters (außer Newline/Tab) raus — Zero-Width-Joiner, BiDi-
    // Overrides etc. können sonst die UI verzerren.
    // eslint-disable-next-line no-control-regex, no-irregular-whitespace
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F​-‏‪-‮⁦-⁩]/g, '')
    // `<` neutralisieren — kein vollständiges HTML-Escape, weil UIs den Text
    // direkt anzeigen.
    .replace(/</g, '‹');
}

export async function notify(tx: TxClient, input: NotifyInput): Promise<void> {
  // Q-8: Title/Body normalisieren BEVOR sie in die DB gehen.
  const title = sanitizeText(input.title);
  const body = input.body != null ? sanitizeText(input.body) : null;
  const where = {
    tenantId: input.tenantId,
    staffId: input.staffId ?? null,
    kind: input.kind,
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    readAt: null,
  };

  // Race-Serialisierung: findFirst-then-create ist ohne Lock nicht atomar —
  // zwei parallele notify() für denselben Dedupe-Key (z. B. Worker-Job +
  // Web-Action) legen sonst beide eine ungelesene Notification an. Ein
  // transaktionsgebundener Advisory-Lock auf den Key serialisiert nur genau
  // diese Kollision (unterschiedliche Keys blockieren sich nicht); der zweite
  // Aufruf sieht dann die Notification des ersten und aktualisiert sie.
  const lockKey = `notify:${where.tenantId}:${where.staffId ?? ''}:${where.kind}:${where.resourceType ?? ''}:${where.resourceId ?? ''}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

  const existing = await tx.notification.findFirst({ where });
  if (existing) {
    // Refresh: Titel/Body aktualisieren, createdAt auf jetzt
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
