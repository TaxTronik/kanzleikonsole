import { createHash } from 'node:crypto';
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type Attachment, type ParsedMail } from 'mailparser';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { withSystemContext } from '@taxtronik/db';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { encryptSecret, decryptSecret } from '@taxtronik/crypto';
import { scanBytes, putObjectBytes, getBucketForTier, MAX_UPLOAD_BYTES } from '@taxtronik/storage';
import { classifyInboundAttachment } from './attachments';
export { classifyInboundAttachment } from './attachments';
import type { InboundAttachment, InboundMailbox, InboundMessage } from '@prisma/client';

export const IMAP_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',
  'openid',
  'profile',
];
/** OAuth callbacks supply a staff-bound writer; background refreshes retain system persistence. */
export function microsoftClient(
  account: InboundMailbox,
  persistEncryptedCache?: (value: string) => Promise<void>,
): ConfidentialClientApplication {
  if (!account.entraTenantId || !account.entraClientId || !account.secretEnc)
    throw new Error('Microsoft-Konfiguration unvollständig.');
  return new ConfidentialClientApplication({
    auth: {
      clientId: account.entraClientId,
      authority: 'https://login.microsoftonline.com/' + account.entraTenantId,
      clientSecret: decryptSecret(account.secretEnc),
    },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (context) => {
          const current = await withSystemContext(account.tenantId, (tx) =>
            tx.inboundMailbox.findUnique({
              where: { id: account.id },
              select: { oauthCacheEnc: true },
            }),
          );
          if (current?.oauthCacheEnc)
            context.tokenCache.deserialize(decryptSecret(current.oauthCacheEnc));
        },
        afterCacheAccess: async (context) => {
          if (context.cacheHasChanged) {
            const encrypted = encryptSecret(context.tokenCache.serialize());
            if (persistEncryptedCache) await persistEncryptedCache(encrypted);
            else
              await withSystemContext(account.tenantId, (tx) =>
                tx.inboundMailbox.update({
                  where: { id: account.id },
                  data: { oauthCacheEnc: encrypted },
                }),
              );
          }
        },
      },
    },
  });
}
export async function connectMailbox(account: InboundMailbox): Promise<ImapFlow> {
  let auth: { user: string; pass: string } | { user: string; accessToken: string };
  if (account.provider === 'MICROSOFT365') {
    const app = microsoftClient(account);
    const profiles = await app.getTokenCache().getAllAccounts();
    if (profiles.length !== 1) throw new Error('MICROSOFT_RECONNECT_REQUIRED');
    const token = await app.acquireTokenSilent({ account: profiles[0]!, scopes: IMAP_SCOPES });
    if (!token?.accessToken) throw new Error('MICROSOFT_RECONNECT_REQUIRED');
    auth = { user: account.username, accessToken: token.accessToken };
  } else {
    if (!account.secretEnc) throw new Error('IMAP-Zugangsdaten fehlen.');
    auth = { user: account.username, pass: decryptSecret(account.secretEnc) };
  }
  const connection = new ImapFlow({
    host: account.provider === 'MICROSOFT365' ? 'outlook.office365.com' : account.host,
    port: account.provider === 'MICROSOFT365' ? 993 : account.port,
    secure: true,
    tls: { rejectUnauthorized: true },
    auth,
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
  await connection.connect();
  return connection;
}
async function stillEnabled(tenantId: string, id: string) {
  return withSystemContext(
    tenantId,
    async (tx) =>
      (await readBooleanTenantModules(tx, tenantId)).smartMailbox &&
      !!(await tx.inboundMailbox.findFirst({ where: { id, tenantId, enabled: true } })),
  );
}
/** Read at most limit + 1 bytes; a forged RFC822.SIZE cannot trigger an unbounded allocation. */
async function boundedMessage(connection: ImapFlow, uid: number): Promise<Buffer | null> {
  const download = await connection.download(String(uid), undefined, {
    uid: true,
    maxBytes: MAX_UPLOAD_BYTES + 1,
    chunkSize: 65536,
  });
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of download.content) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_UPLOAD_BYTES) {
      download.content.destroy();
      return null;
    }
    chunks.push(bytes);
  }
  if (length === 0) throw new Error('Nachricht nicht vollständig lesbar.');
  return Buffer.concat(chunks, length);
}

async function claimMailbox(tenantId: string, id: string): Promise<InboundMailbox | null> {
  return withSystemContext(tenantId, async (tx) => {
    if (!(await readBooleanTenantModules(tx, tenantId)).smartMailbox) return null;
    const claim = await tx.inboundMailbox.updateMany({
      where: {
        id,
        tenantId,
        enabled: true,
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: new Date() } }],
      },
      data: { claimedUntil: new Date(Date.now() + 10 * 60_000) },
    });
    return claim.count === 1 ? tx.inboundMailbox.findUnique({ where: { id } }) : null;
  });
}

async function updateMailbox(
  tenantId: string,
  id: string,
  data: { uidValidity?: string; lastUid?: number; lastSuccessAt?: Date; lastError?: string | null },
): Promise<void> {
  await withSystemContext(tenantId, (tx) => tx.inboundMailbox.update({ where: { id }, data }));
}

async function fetchMailboxMetadata(
  connection: ImapFlow,
  lastUid: number,
): Promise<FetchMessageObject[]> {
  const metadata: FetchMessageObject[] = [];
  for await (const item of connection.fetch(
    String(lastUid + 1) + ':*',
    { uid: true, size: true, envelope: true },
    { uid: true },
  )) {
    if (item.uid > lastUid) metadata.push(item);
    if (metadata.length >= 10) break;
  }
  return metadata;
}

async function upsertInboundMessage(
  tenantId: string,
  mailboxId: string,
  uidValidity: string,
  item: FetchMessageObject,
): Promise<InboundMessage> {
  return withSystemContext(tenantId, (tx) =>
    tx.inboundMessage.upsert({
      where: {
        mailboxId_uidValidity_uid: { mailboxId, uidValidity, uid: item.uid },
      },
      create: {
        mailboxId,
        uidValidity,
        uid: item.uid,
        subject: (item.envelope?.subject ?? '').slice(0, 500),
      },
      update: {},
    }),
  );
}

async function blockInboundMessage(
  tenantId: string,
  messageId: string,
  bodyText: string,
): Promise<void> {
  await withSystemContext(tenantId, (tx) =>
    tx.inboundMessage.update({
      where: { id: messageId },
      data: { status: 'BLOCKED', bodyText },
    }),
  );
}

async function persistParsedMessage(
  tenantId: string,
  messageId: string,
  parsed: ParsedMail,
): Promise<void> {
  await withSystemContext(tenantId, (tx) =>
    tx.inboundMessage.update({
      where: { id: messageId },
      data: {
        sender: (parsed.from?.text ?? '').slice(0, 1000),
        recipients: (Array.isArray(parsed.to)
          ? parsed.to.map((recipient) => recipient.text).join(', ')
          : (parsed.to?.text ?? '')
        ).slice(0, 1000),
        bodyText: (parsed.text ?? '').slice(0, 20000),
      },
    }),
  );
}

async function upsertInboundAttachment(
  tenantId: string,
  messageId: string,
  part: number,
  attachment: Attachment,
  mimeType: string,
  sha256: string,
): Promise<InboundAttachment> {
  return withSystemContext(tenantId, (tx) =>
    tx.inboundAttachment.upsert({
      where: { messageId_part: { messageId, part } },
      create: {
        messageId,
        part,
        filename: (attachment.filename ?? 'Anhang').slice(0, 200),
        mimeType,
        sha256,
        sizeBytes: attachment.content.length,
      },
      update: {},
    }),
  );
}

async function updateInboundAttachment(
  tenantId: string,
  attachmentId: string,
  data: {
    status: 'BLOCKED' | 'SCAN_ERROR' | 'PENDING';
    error?: string | null;
    storageKey?: string;
  },
): Promise<void> {
  await withSystemContext(tenantId, (tx) =>
    tx.inboundAttachment.update({ where: { id: attachmentId }, data }),
  );
}

async function releaseInboundAttachment(
  tenantId: string,
  mailboxId: string,
  attachmentId: string,
): Promise<boolean> {
  return withSystemContext(tenantId, async (tx) => {
    const modules = await readBooleanTenantModules(tx, tenantId);
    const mailbox = await tx.inboundMailbox.findFirst({
      where: { id: mailboxId, tenantId, enabled: true },
    });
    if (!modules.smartMailbox || !mailbox) return false;
    await tx.inboundAttachment.update({
      where: { id: attachmentId },
      data: { status: 'CLEAN', error: null },
    });
    return true;
  });
}

async function processInboundAttachment(
  tenantId: string,
  mailboxId: string,
  messageId: string,
  part: number,
  attachment: Attachment,
): Promise<boolean> {
  if (!(await stillEnabled(tenantId, mailboxId))) return false;
  const sha256 = createHash('sha256').update(attachment.content).digest('hex');
  const kind = await classifyInboundAttachment(attachment.content);
  const row = await upsertInboundAttachment(
    tenantId,
    messageId,
    part,
    attachment,
    kind.mime,
    sha256,
  );
  if (row.sha256 !== sha256 || row.sizeBytes !== attachment.content.length)
    throw new Error('Anhangdaten haben sich bei gleicher Nachrichtenkennung geändert.');
  if (['CLEAN', 'IMPORTING', 'IMPORTED', 'BLOCKED'].includes(row.status)) return true;

  const scan = kind.blocked ? 'ERROR' : await scanBytes(attachment.content);
  if (kind.blocked || scan === 'INFECTED') {
    await updateInboundAttachment(tenantId, row.id, {
      status: 'BLOCKED',
      error: kind.blocked ?? 'Schadsoftware erkannt.',
    });
    return true;
  }
  if (scan !== 'CLEAN') {
    await updateInboundAttachment(tenantId, row.id, {
      status: 'SCAN_ERROR',
      error: 'Virenscanner nicht verfügbar; keine Freigabe.',
    });
    throw new Error('Virenscanner nicht verfügbar.');
  }

  const key = tenantId + '/inbound-staging/' + row.id + '/' + sha256;
  await updateInboundAttachment(tenantId, row.id, { storageKey: key, status: 'PENDING' });
  await putObjectBytes(getBucketForTier('NONE'), key, attachment.content, {
    contentType: kind.mime,
  });
  return releaseInboundAttachment(tenantId, mailboxId, row.id);
}

async function processInboundAttachments(
  tenantId: string,
  mailboxId: string,
  messageId: string,
  attachments: Attachment[],
): Promise<boolean> {
  for (let part = 0; part < attachments.length; part++) {
    const released = await processInboundAttachment(
      tenantId,
      mailboxId,
      messageId,
      part,
      attachments[part]!,
    );
    if (!released) return false;
  }
  return true;
}

async function processInboundMessage(
  tenantId: string,
  account: InboundMailbox,
  connection: ImapFlow,
  uidValidity: string,
  item: FetchMessageObject,
): Promise<'ADVANCE' | 'STOP'> {
  const message = await upsertInboundMessage(tenantId, account.id, uidValidity, item);
  if (message.status === 'COMPLETE' || message.status === 'BLOCKED') return 'ADVANCE';
  if ((item.size ?? MAX_UPLOAD_BYTES + 1) > MAX_UPLOAD_BYTES) {
    await blockInboundMessage(tenantId, message.id, 'Nachricht überschreitet das Größenlimit.');
    return 'ADVANCE';
  }

  const source = await boundedMessage(connection, item.uid);
  if (!source) {
    await blockInboundMessage(tenantId, message.id, 'Nachricht überschreitet das Größenlimit.');
    return 'ADVANCE';
  }
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  // MAIL-INBOX-001: A permanent content limit must not hold the mailbox cursor
  // forever. Keep the receipt blocked and continue with subsequent messages.
  if (parsed.attachments.length > 50) {
    await blockInboundMessage(
      tenantId,
      message.id,
      'Nachricht überschreitet das Limit von 50 Anhängen.',
    );
    return 'ADVANCE';
  }
  await persistParsedMessage(tenantId, message.id, parsed);
  const released = await processInboundAttachments(
    tenantId,
    account.id,
    message.id,
    parsed.attachments,
  );
  if (!released) return 'STOP';
  await withSystemContext(tenantId, (tx) =>
    tx.inboundMessage.update({ where: { id: message.id }, data: { status: 'COMPLETE' } }),
  );
  return 'ADVANCE';
}

async function runMailboxPoll(
  tenantId: string,
  account: InboundMailbox,
  connection: ImapFlow,
): Promise<void> {
  const mailbox = await connection.mailboxOpen(account.folder, { readOnly: true });
  const uidValidity = String(mailbox.uidValidity);
  if (account.uidValidity && uidValidity !== account.uidValidity)
    throw new Error(
      'UIDVALIDITY_CHANGED: Synchronisierung angehalten. Kontrollierter Neuabgleich erforderlich.',
    );
  await updateMailbox(tenantId, account.id, { uidValidity });
  const metadata = await fetchMailboxMetadata(connection, account.lastUid);
  for (const item of metadata) {
    if (!(await stillEnabled(tenantId, account.id))) break;
    const outcome = await processInboundMessage(tenantId, account, connection, uidValidity, item);
    if (outcome === 'STOP') return;
    await updateMailbox(tenantId, account.id, { lastUid: item.uid });
  }
  await updateMailbox(tenantId, account.id, { lastSuccessAt: new Date(), lastError: null });
}

function mailboxErrorState(
  account: InboundMailbox,
  error: unknown,
): {
  lastError: string;
  enabled?: false;
} {
  const text = error instanceof Error ? error.message : '';
  const reconnect =
    /interaction_required|invalid_grant|RECONNECT|invalid_client/.test(text) ||
    (account.provider === 'MICROSOFT365' &&
      /AUTHENTICATE|AUTHENTICATION|authentication failed/i.test(text));
  const lastError = reconnect
    ? 'Microsoft-Verbindung erneuern.'
    : text.startsWith('UIDVALIDITY_CHANGED')
      ? text
      : 'Abruf fehlgeschlagen. TLS, Zugang, IMAP-Freigabe und Virenscanner prüfen.';
  return reconnect || text.startsWith('UIDVALIDITY_CHANGED')
    ? { lastError, enabled: false }
    : { lastError };
}

/** Read-only IMAP. Durable receipts survive process crashes independently of the cursor. */
export async function pollMailbox(tenantId: string, id: string): Promise<void> {
  const account = await claimMailbox(tenantId, id);
  if (!account) return;
  let connection: ImapFlow | undefined;
  try {
    connection = await connectMailbox(account);
    await runMailboxPoll(tenantId, account, connection);
  } catch (error) {
    // Do not leak provider errors, tokens, subjects or credentials into logs.
    const state = mailboxErrorState(account, error);
    await withSystemContext(tenantId, (tx) =>
      tx.inboundMailbox.update({
        where: { id },
        data: state,
      }),
    );
  } finally {
    if (connection) await connection.logout().catch(() => connection?.close());
    await withSystemContext(tenantId, (tx) =>
      tx.inboundMailbox.update({ where: { id }, data: { claimedUntil: null } }),
    );
  }
}
