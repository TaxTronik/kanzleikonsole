'use server';

import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { withTenantContext, type TxClient } from '@taxtronik/db';
import {
  encryptSecret,
  mailboxOauthStateContext,
  SECRET_SLOTS,
  secretSlotContext,
} from '@taxtronik/crypto';
import { env } from '@taxtronik/config';
import { microsoftClient, IMAP_SCOPES } from '@taxtronik/mail/imap';
import { fetchVerifiedObjectBytes, getBucketForTier, StoredObjectError } from '@taxtronik/storage';
import {
  staffAction,
  ActionError,
  type ActionResult,
  type StaffCtx,
} from '@/server/actions/staff-action';
import { formFlag, parseFormData, validationFailure } from '@/server/actions/form-data';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { readBooleanTenantModules } from '@taxtronik/db/tenant-modules';
import { persistResumableDocumentUpload } from '@/server/documents/resumable-upload';
import { carrierClassification } from '@/server/storage/document-type';
import type { DocumentClassification } from '@prisma/client';
import { audit } from '@/server/actions/audit';

/** Postfach-ID aus dem Formular; ungültig → „Ungültige Postfach-ID.“ samt Feldfehler. */
const MAILBOX_FORM = { absentAsNull: true, errorMessage: 'Ungültige Postfach-ID.' } as const;

export async function saveMailbox(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true, module: 'smartMailbox' },
    parse: () => {
      const parsed = z
        .object({
          name: z.string().trim().min(1).max(100),
          provider: z.enum(['IMAP', 'MICROSOFT365']),
          host: z
            .string()
            .trim()
            .min(1)
            .max(253)
            .regex(/^[a-zA-Z0-9.-]+$/),
          port: z.coerce.number().int().min(1).max(65535),
          username: z.email().max(254),
          folder: z.string().trim().min(1).max(200),
          secret: z.string().min(1).max(5000),
          entraTenantId: z.union([z.uuid(), z.literal('')]),
          entraClientId: z.union([z.uuid(), z.literal('')]),
        })
        .safeParse(Object.fromEntries(form));
      return parsed.success
        ? { ok: true, data: parsed.data }
        : validationFailure(parsed.error.issues);
    },
    run: async (g, input) => {
      if (input.provider === 'MICROSOFT365' && (!input.entraTenantId || !input.entraClientId))
        return { ok: false, error: 'Entra-Mandanten-ID und App-ID erforderlich.' };
      // S-08: Die Zeilen-ID gehört zum AAD-Kontext des Zugangs; sie wird daher vor
      // dem Verschlüsseln festgelegt statt per Datenbank-Default vergeben.
      const mailboxId = randomUUID();
      await withTenantContext(g.ctx, async (tx) => {
        const item = await tx.inboundMailbox.create({
          data: {
            id: mailboxId,
            tenantId: g.tenantId,
            name: input.name,
            provider: input.provider,
            host: input.provider === 'MICROSOFT365' ? 'outlook.office365.com' : input.host,
            port: input.provider === 'MICROSOFT365' ? 993 : input.port,
            username: input.username,
            folder: input.folder,
            secretEnc: encryptSecret(
              input.secret,
              secretSlotContext(SECRET_SLOTS.mailboxSecret, {
                tenantId: g.tenantId,
                rowId: mailboxId,
              }),
            ),
            entraTenantId: input.entraTenantId || null,
            entraClientId: input.entraClientId || null,
            enabled: false,
          },
        });
        await audit(tx, g, {
          action: 'mailbox.created',
          resourceType: 'inbound_mailbox',
          resourceId: item.id,
          after: { provider: input.provider, enabled: false },
        });
      });
    },
    revalidate: '/staff/mailbox',
  });
}
export async function setMailboxEnabled(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true, module: 'smartMailbox' },
    parse: () =>
      parseFormData(z.object({ id: z.uuid(), enabled: formFlag('true') }), form, MAILBOX_FORM),
    run: async (g, { id, enabled }) => {
      await withTenantContext(g.ctx, async (tx) => {
        const account = await tx.inboundMailbox.findFirst({ where: { id, tenantId: g.tenantId } });
        if (!account) throw new ActionError('Postfach nicht gefunden.');
        if (enabled && account.provider === 'MICROSOFT365' && !account.oauthCacheEnc)
          throw new ActionError('Zuerst Microsoft-Verbindung herstellen.');
        if (enabled && account.lastError?.startsWith('UIDVALIDITY_CHANGED'))
          throw new ActionError(
            'Ordnerkennung geändert. Bitte ein neues Postfachprofil für einen kontrollierten Neuabgleich anlegen. Vorhandene Nachweise bleiben erhalten.',
          );
        await tx.inboundMailbox.update({ where: { id }, data: { enabled } });
        await audit(tx, g, {
          action: 'mailbox.' + (enabled ? 'resumed' : 'paused'),
          resourceType: 'inbound_mailbox',
          resourceId: id,
          after: { enabled },
        });
      });
    },
    revalidate: '/staff/mailbox',
  });
}
export async function connectMicrosoft(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  const result = await staffAction({
    guard: { requireAdmin: true, module: 'smartMailbox' },
    parse: () => parseFormData(z.object({ id: z.uuid() }), form, MAILBOX_FORM),
    run: async (g, { id }) => ({ url: await prepareMicrosoftConnect(g, id) }),
  });
  if (!result.ok) return result;
  // Erfolg: Weiterleitung zur Microsoft-Anmeldung (außerhalb des Fehler-Mappings).
  redirect(result.url);
}

/** Setzt das Postfach zurück, legt den PKCE-Cookie an und liefert die Anmelde-URL. */
async function prepareMicrosoftConnect(g: StaffCtx, id: string): Promise<string> {
  const account = await withTenantContext(g.ctx, (tx) =>
    tx.inboundMailbox.findFirst({ where: { id, tenantId: g.tenantId, provider: 'MICROSOFT365' } }),
  );
  if (!account) throw new ActionError('Postfach nicht gefunden.');
  await withTenantContext(g.ctx, (tx) =>
    tx.inboundMailbox.update({
      where: { id: account.id },
      data: { enabled: false, oauthCacheEnc: null },
    }),
  );
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const redirectUri = new URL('/api/staff/mailbox/oauth', env.NEXTAUTH_URL).toString();
  const url = await microsoftClient(account).getAuthCodeUrl({
    scopes: IMAP_SCOPES,
    redirectUri,
    state,
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256',
    prompt: 'select_account',
  });
  (await cookies()).set(
    'tt-mailbox-oauth',
    encryptSecret(
      JSON.stringify({
        id,
        staffId: g.staffId,
        tenantId: g.tenantId,
        state,
        verifier,
        expires: Date.now() + 300000,
      }),
      mailboxOauthStateContext(g.tenantId, g.staffId),
    ),
    {
      httpOnly: true,
      secure: new URL(env.NEXTAUTH_URL).protocol === 'https:',
      sameSite: 'lax',
      path: '/api/staff/mailbox/oauth',
      maxAge: 300,
    },
  );
  return url;
}
export async function importAttachment(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requirePermission: 'INBOUND_MAIL_MANAGE', module: 'smartMailbox' },
    parse: () => {
      const parsed = z
        .object({ id: z.uuid(), clientId: z.uuid(), documentTypeId: z.uuid() })
        .safeParse(Object.fromEntries(form));
      return parsed.success
        ? { ok: true, data: parsed.data }
        : validationFailure(parsed.error.issues);
    },
    run: (g, input) => archiveAttachment(g, input),
    revalidate: '/staff/mailbox',
  });
}

/**
 * R-05: Anhangbytes über den gemeinsamen, immer prüfenden Leseweg; Größe und
 * SHA-256 des geprüften Anhangs werden beim Lesen verglichen. Meldung bei
 * Abweichung wie bisher.
 */
async function readInboundAttachmentBytes(attachment: {
  storageKey: string | null;
  sha256: string;
  sizeBytes: number;
}): Promise<Buffer> {
  try {
    return await fetchVerifiedObjectBytes(
      { bucket: getBucketForTier('NONE'), key: attachment.storageKey! },
      { sizeBytes: attachment.sizeBytes, sha256: attachment.sha256 },
    );
  } catch (error) {
    if (error instanceof StoredObjectError && error.integrityViolation)
      throw new ActionError('Anhang-Prüfsumme stimmt nicht.');
    throw error;
  }
}

/** Übernimmt einen geprüften Anhang ins Mandantenarchiv; Fachfehler werfen ActionError. */
async function archiveAttachment(
  g: StaffCtx,
  input: { id: string; clientId: string; documentTypeId: string },
): Promise<void> {
  const prepared = await withTenantContext(g.ctx, async (tx) => {
    await assertClientAccessTx(tx, g.session, input.clientId);
    const client = await tx.client.findFirst({
      where: {
        id: input.clientId,
        tenantId: g.tenantId,
        allowActive: true,
        anonymizedAt: null,
        mandateEndedAt: null,
      },
    });
    if (!client) throw new ActionError('Mandat nicht aktiv.');
    const attachment = await tx.inboundAttachment.findFirst({
      where: {
        id: input.id,
        status: { in: ['CLEAN', 'IMPORTING', 'IMPORTED'] },
        message: { mailbox: { tenantId: g.tenantId } },
      },
    });
    const type = await tx.documentType.findFirst({
      where: { id: input.documentTypeId, tenantId: g.tenantId, active: true },
    });
    if (
      !attachment?.storageKey ||
      !type ||
      type.tier === 'GWG' ||
      ['STAFF_PRIVATE', 'PERSONNEL'].includes(type.classificationKey ?? '')
    )
      throw new ActionError('Anhang oder zulässiger Ablagetyp nicht verfügbar.');
    if (attachment.documentId) {
      const existing = await tx.document.findFirst({
        where: {
          id: attachment.documentId,
          tenantId: g.tenantId,
          clientId: input.clientId,
          documentTypeId: type.id,
        },
      });
      if (!existing)
        throw new ActionError(
          'Der begonnene Import hat eine andere Zuordnung. Bitte ursprüngliche Auswahl verwenden.',
        );
    }
    return { attachment, type };
  });
  const { attachment, type } = prepared;
  let activeDocumentId = attachment.documentId;
  const guardImportTx = async (tx: TxClient) => {
    if (!(await readBooleanTenantModules(tx, g.tenantId)).smartMailbox)
      throw new ActionError('Modul deaktiviert.');
    const freshType = await tx.documentType.findFirst({
      where: {
        id: type.id,
        tenantId: g.tenantId,
        active: true,
        tier: type.tier,
        classificationKey: type.classificationKey,
        retentionYears: type.retentionYears,
      },
    });
    if (!freshType)
      throw new ActionError(
        'Dokumenttyp oder Aufbewahrungsklasse wurde geändert. Zuordnung erneut prüfen.',
      );
    await assertClientAccessTx(tx, g.session, input.clientId);
    const valid = await tx.client.findFirst({
      where: {
        id: input.clientId,
        tenantId: g.tenantId,
        allowActive: true,
        anonymizedAt: null,
        mandateEndedAt: null,
      },
    });
    if (!valid) throw new ActionError('Mandat nicht aktiv.');
    const row = await tx.inboundAttachment.findFirst({
      where: {
        id: attachment.id,
        status: { in: ['CLEAN', 'IMPORTING', 'IMPORTED'] },
        message: { mailbox: { tenantId: g.tenantId } },
      },
    });
    if (!row || row.documentId !== activeDocumentId)
      throw new ActionError('Import wurde zwischenzeitlich begonnen. Seite neu laden.');
  };
  await persistResumableDocumentUpload({
    context: g.ctx,
    resumeDocumentId: attachment.documentId,
    createdById: g.staffId,
    documentData: {
      tenantId: g.tenantId,
      clientId: input.clientId,
      title: attachment.filename,
      mimeType: attachment.mimeType,
      documentTypeId: type.id,
      classification: carrierClassification(
        type.tier,
        type.classificationKey,
      ) as DocumentClassification,
    },
    resumeWhere: {
      clientId: input.clientId,
      documentTypeId: type.id,
      sharedWithClientAt: null,
      deletedAt: null,
    },
    storage: {
      tier: type.tier,
      classification: type.classificationKey ?? undefined,
      expectedMime: attachment.mimeType,
      retentionYears: type.retentionYears ?? undefined,
    },
    readBytes: () => readInboundAttachmentBytes(attachment),
    guardMutationTx: guardImportTx,
    recordPendingTx: async (tx, upload) => {
      const claim = await tx.inboundAttachment.updateMany({
        where: { id: attachment.id, documentId: null, status: 'CLEAN' },
        data: { documentId: upload.documentId, clientId: input.clientId, status: 'IMPORTING' },
      });
      if (claim.count !== 1) throw new ActionError('Import bereits begonnen.');
      activeDocumentId = upload.documentId;
    },
    recordCompleteTx: async (tx, upload) => {
      await guardImportTx(tx);
      await tx.inboundAttachment.update({
        where: { id: attachment.id },
        data: { status: 'IMPORTED' },
      });
      await audit(tx, g, {
        action: 'mailbox.attachment_archived',
        resourceType: 'document',
        resourceId: upload.documentId,
        after: {
          sourceAttachmentId: attachment.id,
          sourceSha256: attachment.sha256,
          versionId: upload.versionId,
          clientId: input.clientId,
          documentTypeId: type.id,
          sharedWithClient: false,
        },
      });
    },
  });
}
