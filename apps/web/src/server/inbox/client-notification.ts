import { portalBaseUrl } from '@taxtronik/config';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { resolveNotificationsTx } from '@taxtronik/db/notification';
import { notifyClientContacts } from '@/server/mail/dispatch';
import { notify } from '@/server/notifications/service';
import { evidenceService } from '@/server/container';
import { log } from '@/server/logger';
import { ActionError } from '@/server/actions/action-error';

// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001, AUDIT-HASH-CHAIN-001,
// PORTAL-INBOX-SUBMISSION-001 (Entwurf). Kein Betreff, Nachrichtentext oder
// Dateiname verlaesst den sicheren Verlauf ueber Mail/Audit/Logs.

export interface InboxClientMailResult {
  delivered: boolean;
  attempted: number;
  accepted: number;
  safeToRetry: boolean;
}

const MAIL_JOURNAL_ACTIONS = [
  'portal_inbox.client_activity_mail_claimed',
  'portal_inbox.client_activity_mail_completed',
  'portal_inbox.client_activity_mail_failed',
] as const;

function retryableFromAudit(after: unknown): boolean {
  return after !== null && typeof after === 'object' && !Array.isArray(after)
    ? (after as Record<string, unknown>)['safeToRetry'] === true
    : false;
}

export async function sendInboxClientActivityMail(input: {
  context: TenantContext;
  tenantId: string;
  clientId: string;
  staffId: string;
  threadId: string;
  messageId: string;
}): Promise<InboxClientMailResult> {
  if (
    input.context.tenantId !== input.tenantId ||
    input.context.actorType !== 'STAFF' ||
    input.context.actorId !== input.staffId
  ) {
    throw new ActionError('Ungültiger Kanzleikontext für den Portal-Hinweis.');
  }
  const claim = await withTenantContext(input.context, async (tx) => {
    const lockKey = `portal-inbox-client-mail:${input.tenantId}:${input.messageId}`;
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
    const [scope] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM portal_inbox_message message
        WHERE message.id = ${input.messageId}::uuid
          AND message.tenant_id = ${input.tenantId}::uuid
          AND message.client_id = ${input.clientId}::uuid
          AND message.thread_id = ${input.threadId}::uuid
          AND message.author_type = 'STAFF'
          AND app.portal_inbox_staff_access(message.tenant_id, message.client_id)
      ) AS allowed
    `;
    if (!scope?.allowed) {
      throw new ActionError('Portal-Nachricht oder aktueller Mandantenzugriff nicht verfügbar.');
    }
    const latest = await tx.auditLog.findFirst({
      where: {
        tenantId: input.tenantId,
        action: { in: [...MAIL_JOURNAL_ACTIONS] },
        resourceType: 'portal_inbox_message',
        resourceId: input.messageId,
      },
      orderBy: { id: 'desc' },
      select: { action: true, after: true },
    });
    if (latest?.action === 'portal_inbox.client_activity_mail_completed') {
      return { send: false, delivered: true };
    }
    // Ein stehengebliebener Claim ist absichtlich nicht automatisch
    // wiederholbar: Der Prozess könnte nach Providerannahme abgestürzt sein.
    if (latest?.action === 'portal_inbox.client_activity_mail_claimed') {
      return { send: false, delivered: false };
    }
    if (
      latest?.action === 'portal_inbox.client_activity_mail_failed' &&
      !retryableFromAudit(latest.after)
    ) {
      return { send: false, delivered: false };
    }
    await evidenceService.record(tx, {
      tenantId: input.tenantId,
      actorType: 'STAFF',
      actorId: input.staffId,
      action: 'portal_inbox.client_activity_mail_claimed',
      resourceType: 'portal_inbox_message',
      resourceId: input.messageId,
      after: { retry: latest?.action === 'portal_inbox.client_activity_mail_failed' },
    });
    return { send: true, delivered: false };
  });
  if (!claim.send) {
    return {
      delivered: claim.delivered,
      attempted: 0,
      accepted: 0,
      safeToRetry: false,
    } satisfies InboxClientMailResult;
  }

  let attempted = 0;
  let accepted = 0;
  let uncertainFailure = false;
  let externalSideEffectOccurred = false;
  let thrown = false;
  try {
    const result = await notifyClientContacts({
      tenantId: input.tenantId,
      clientId: input.clientId,
      slug: 'portal-inbox-activity',
      vars: {
        link: `${portalBaseUrl}/portal/inbox/${input.threadId}`,
      },
      fallback: {
        subject: 'Neue Nachricht im Mandantenportal',
        bodyMd:
          'In Ihrem sicheren Nachrichtenfach liegt eine neue Antwort der Kanzlei.\n\n' +
          '[Nachrichtenfach öffnen]({{link}})\n\n' +
          'Diese E-Mail enthält bewusst keine Vorschau der Nachricht oder von Anlagen.',
      },
    });
    attempted = result.attempted;
    accepted = result.recipients;
    uncertainFailure = result.uncertainFailure;
    externalSideEffectOccurred = result.externalSideEffectOccurred;
  } catch (error) {
    thrown = true;
    // Ein Throw kann nach Providerannahme erfolgt sein. Ohne expliziten
    // Provider-Nachweis ist ein automatischer Retry deshalb nicht sicher.
    uncertainFailure = true;
    log.error(
      {
        component: 'portal-inbox-client-mail',
        tenantId: input.tenantId,
        threadId: input.threadId,
        messageId: input.messageId,
        errorType: error instanceof Error ? error.name : typeof error,
      },
      'neutral portal inbox activity mail failed',
    );
  }

  const delivered = !thrown && accepted === attempted && !uncertainFailure;
  const safeToRetry =
    !thrown && !delivered && accepted === 0 && !uncertainFailure && !externalSideEffectOccurred;
  await withTenantContext(input.context, async (tx) => {
    if (delivered) {
      await resolveNotificationsTx(tx, {
        tenantId: input.tenantId,
        resources: [{ resourceType: 'portal_inbox_message', resourceId: input.messageId }],
        kinds: ['SYSTEM_MAIL_FAILED'],
      });
      await evidenceService.record(tx, {
        tenantId: input.tenantId,
        actorType: 'STAFF',
        actorId: input.staffId,
        action: 'portal_inbox.client_activity_mail_completed',
        resourceType: 'portal_inbox_message',
        resourceId: input.messageId,
        after: { attempted, accepted },
      });
      return;
    }

    await notify(tx, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      staffId: input.staffId,
      kind: 'SYSTEM_MAIL_FAILED',
      title: 'Portal-E-Mail konnte nicht vollständig zugestellt werden',
      body: safeToRetry
        ? 'Der neutrale Aktivitätshinweis kann sicher erneut versucht werden.'
        : 'Der Versand muss wegen möglicher Teilzustellung manuell geprüft werden.',
      href: `/staff/inbox/${input.threadId}`,
      resourceType: 'portal_inbox_message',
      resourceId: input.messageId,
    });
    await evidenceService.record(tx, {
      tenantId: input.tenantId,
      actorType: 'STAFF',
      actorId: input.staffId,
      action: 'portal_inbox.client_activity_mail_failed',
      resourceType: 'portal_inbox_message',
      resourceId: input.messageId,
      after: { attempted, accepted, uncertainFailure, safeToRetry, thrown },
    });
  });
  return { delivered, attempted, accepted, safeToRetry };
}
