import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import {
  assertActivePortalInboxIdentityTx,
  assertInboxFeatureTx,
  assertStaffInboxClientTx,
} from './access';
import { INBOX_PAGE_SIZE, INBOX_STAFF_PAGE_SIZE, type InboxTopic } from './constants';
import type {
  InboxAttachmentView,
  InboxMessageView,
  InboxThreadDetail,
  InboxThreadListItem,
} from './types';
import { inboxMetadataSearch } from './search';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001 (Entwurf), ACCESS-TENANT-RLS-001,
// ACCESS-STAFF-PERMISSION-001, DOC-PORTAL-SHARING-001.

export interface InboxListFilters {
  page?: number;
  query?: string;
  topic?: InboxTopic;
  status?: 'OPEN' | 'RESOLVED';
  attention?: 'STAFF' | 'CLIENT' | 'NONE';
}

export interface StaffInboxListFilters extends InboxListFilters {
  scope?: 'mine' | 'team' | 'all';
}

export interface InboxListResult {
  items: InboxThreadListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function normalizePage(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : 1;
}

function normalizeQuery(value: string | undefined): string {
  return (value ?? '').trim().slice(0, 120);
}

function filteredWhere(
  filters: InboxListFilters,
  surface: 'portal' | 'staff',
): Prisma.PortalInboxThreadWhereInput {
  const query = normalizeQuery(filters.query);
  return {
    ...(filters.topic ? { topic: filters.topic } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.attention ? { attention: filters.attention } : {}),
    ...(query ? { OR: inboxMetadataSearch(query, surface) } : {}),
  };
}

function listItem(
  row: {
    id: string;
    clientId: string;
    subject: string;
    topic: InboxTopic;
    status: 'OPEN' | 'RESOLVED';
    attention: 'STAFF' | 'CLIENT' | 'NONE';
    assignedStaffId: string | null;
    lastMessageAt: Date;
    client: { name: string };
    assignedStaff: { fullName: string } | null;
    reads?: Array<{ lastReadAt: Date }>;
  },
  pendingAttachmentCount?: number,
): InboxThreadListItem {
  const lastRead = row.reads?.[0]?.lastReadAt;
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.client.name,
    subject: row.subject,
    topic: row.topic,
    status: row.status,
    attention: row.attention,
    assignedStaffId: row.assignedStaffId,
    assignedStaffName: row.assignedStaff?.fullName ?? null,
    lastMessageAt: row.lastMessageAt,
    ...(row.reads ? { unread: !lastRead || lastRead < row.lastMessageAt } : {}),
    ...(pendingAttachmentCount !== undefined ? { pendingAttachmentCount } : {}),
  };
}

export async function listPortalInboxThreadsTx(
  tx: TxClient,
  actor: { tenantId: string; clientId: string; contactId: string },
  filters: InboxListFilters,
): Promise<InboxListResult> {
  await assertActivePortalInboxIdentityTx(tx, actor);
  const requestedPage = normalizePage(filters.page);
  const where: Prisma.PortalInboxThreadWhereInput = {
    tenantId: actor.tenantId,
    clientId: actor.clientId,
    ...filteredWhere(filters, 'portal'),
  };
  const total = await tx.portalInboxThread.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / INBOX_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const rows = await tx.portalInboxThread.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * INBOX_PAGE_SIZE,
    take: INBOX_PAGE_SIZE,
    select: {
      id: true,
      clientId: true,
      subject: true,
      topic: true,
      status: true,
      attention: true,
      assignedStaffId: true,
      lastMessageAt: true,
      client: { select: { name: true } },
      assignedStaff: { select: { fullName: true } },
      reads: {
        where: { contactId: actor.contactId },
        take: 1,
        select: { lastReadAt: true },
      },
    },
  });
  return {
    items: rows.map((row) => listItem(row)),
    page,
    pageSize: INBOX_PAGE_SIZE,
    total,
    totalPages,
  };
}

export async function listStaffInboxThreadsTx(
  tx: TxClient,
  session: StaffSession,
  filters: StaffInboxListFilters,
): Promise<InboxListResult> {
  const { tenantId, staffId } = session.user;
  await assertInboxFeatureTx(tx, tenantId);
  const requestedPage = normalizePage(filters.page);
  const clientAccess = await accessibleClientsWhereFor(tx, session);
  const scope = filters.scope ?? 'mine';
  const where: Prisma.PortalInboxThreadWhereInput = {
    tenantId,
    ...filteredWhere(filters, 'staff'),
    ...(scope === 'mine'
      ? { assignedStaffId: staffId }
      : scope === 'team'
        ? { assignedStaffId: null }
        : {}),
    client: {
      AND: [
        clientAccess,
        { tenantId, allowActive: true, anonymizedAt: null, mandateEndedAt: null },
      ],
    },
  };
  const total = await tx.portalInboxThread.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / INBOX_STAFF_PAGE_SIZE));
  const page = Math.min(requestedPage, totalPages);
  const rows = await tx.portalInboxThread.findMany({
    where,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    skip: (page - 1) * INBOX_STAFF_PAGE_SIZE,
    take: INBOX_STAFF_PAGE_SIZE,
    select: {
      id: true,
      clientId: true,
      subject: true,
      topic: true,
      status: true,
      attention: true,
      assignedStaffId: true,
      lastMessageAt: true,
      client: { select: { name: true } },
      assignedStaff: { select: { fullName: true } },
    },
  });
  const pending = new Map<string, number>();
  if (rows.length > 0) {
    const attachments = await tx.portalInboxAttachment.findMany({
      where: {
        tenantId,
        decision: 'PENDING_REVIEW',
        message: { threadId: { in: rows.map((row) => row.id) } },
      },
      select: { message: { select: { threadId: true } } },
    });
    for (const attachment of attachments) {
      pending.set(
        attachment.message!.threadId,
        (pending.get(attachment.message!.threadId) ?? 0) + 1,
      );
    }
  }
  return {
    items: rows.map((row) => listItem(row, pending.get(row.id) ?? 0)),
    page,
    pageSize: INBOX_STAFF_PAGE_SIZE,
    total,
    totalPages,
  };
}

function attachmentView(
  attachment: {
    id: string;
    originalName: string;
    mimeType: string;
    sizeBytes: bigint;
    scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
    decision: 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
    acceptedDocumentId: string | null;
    rejectionReason: string | null;
  },
  surface: 'portal' | 'staff',
): InboxAttachmentView {
  const downloadable =
    attachment.scanStatus === 'CLEAN' &&
    (attachment.decision === 'PENDING_REVIEW' || attachment.decision === 'ACCEPTED');
  return {
    id: attachment.id,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes.toString(),
    scanStatus: attachment.scanStatus,
    decision: attachment.decision,
    acceptedDocumentId: attachment.acceptedDocumentId,
    rejectionReason: attachment.rejectionReason,
    downloadHref: downloadable ? `/api/${surface}/inbox/attachments/${attachment.id}` : null,
  };
}

async function hydrateMessagesTx(
  tx: TxClient,
  rows: Array<{
    id: string;
    authorType: 'STAFF' | 'CLIENT_CONTACT';
    authorId: string;
    body: string;
    createdAt: Date;
    attachments: Array<{
      id: string;
      originalName: string;
      mimeType: string;
      sizeBytes: bigint;
      scanStatus: 'PENDING' | 'CLEAN' | 'BLOCKED';
      decision: 'PENDING_REVIEW' | 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
      acceptedDocumentId: string | null;
      rejectionReason: string | null;
    }>;
  }>,
  surface: 'portal' | 'staff',
): Promise<InboxMessageView[]> {
  const staffIds = rows.filter((row) => row.authorType === 'STAFF').map((row) => row.authorId);
  const contactIds = rows
    .filter((row) => row.authorType === 'CLIENT_CONTACT')
    .map((row) => row.authorId);
  const staff = staffIds.length
    ? await tx.staffUser.findMany({
        where: { id: { in: [...new Set(staffIds)] } },
        select: { id: true, fullName: true },
      })
    : [];
  const contacts = contactIds.length
    ? await tx.clientContact.findMany({
        where: { id: { in: [...new Set(contactIds)] } },
        select: { id: true, fullName: true },
      })
    : [];
  const names = new Map([
    ...staff.map((entry) => [entry.id, entry.fullName] as const),
    ...contacts.map((entry) => [entry.id, entry.fullName] as const),
  ]);
  return rows.map((row) => ({
    id: row.id,
    authorType: row.authorType,
    authorName:
      names.get(row.authorId) ?? (row.authorType === 'STAFF' ? 'Kanzlei' : 'Portal-Kontakt'),
    body: row.body,
    createdAt: row.createdAt,
    attachments: row.attachments.map((attachment) => attachmentView(attachment, surface)),
  }));
}

const DETAIL_SELECT = {
  id: true,
  clientId: true,
  subject: true,
  topic: true,
  status: true,
  attention: true,
  assignedStaffId: true,
  lastMessageAt: true,
  resolvedAt: true,
  client: { select: { name: true } },
  assignedStaff: { select: { fullName: true } },
  createdByContact: { select: { fullName: true } },
  messages: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      authorType: true,
      authorId: true,
      body: true,
      createdAt: true,
      attachments: {
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          scanStatus: true,
          decision: true,
          acceptedDocumentId: true,
          rejectionReason: true,
        },
      },
    },
  },
} satisfies Prisma.PortalInboxThreadSelect;

async function detailFromRowTx(
  tx: TxClient,
  row: Prisma.PortalInboxThreadGetPayload<{ select: typeof DETAIL_SELECT }>,
  surface: 'portal' | 'staff',
): Promise<InboxThreadDetail> {
  return {
    ...listItem(row),
    createdByContactName: row.createdByContact.fullName,
    resolvedAt: row.resolvedAt,
    messages: await hydrateMessagesTx(tx, row.messages, surface),
  };
}

export async function getPortalInboxThreadTx(
  tx: TxClient,
  actor: { tenantId: string; clientId: string; contactId: string },
  threadId: string,
): Promise<InboxThreadDetail | null> {
  await assertActivePortalInboxIdentityTx(tx, actor);
  const row = await tx.portalInboxThread.findFirst({
    where: { id: threadId, tenantId: actor.tenantId, clientId: actor.clientId },
    select: DETAIL_SELECT,
  });
  if (!row) return null;
  const detail = await detailFromRowTx(tx, row, 'portal');
  const receipts = await tx.$queryRaw<
    Array<{
      attachmentId: string;
      messageId: string;
      originalName: string;
      mimeType: string;
      sizeBytes: bigint;
      decision: string;
      rejectionReason: string | null;
      decidedAt: Date | null;
      downloadAllowed: boolean;
    }>
  >`
    SELECT
      "attachment_id" AS "attachmentId",
      "message_id" AS "messageId",
      "original_name" AS "originalName",
      "mime_type" AS "mimeType",
      "size_bytes" AS "sizeBytes",
      "decision"::text AS "decision",
      "rejection_reason" AS "rejectionReason",
      "decided_at" AS "decidedAt",
      "download_allowed" AS "downloadAllowed"
    FROM app.portal_inbox_attachment_receipts(
      ${actor.tenantId}::uuid,
      ${threadId}::uuid
    )
  `;
  const messageById = new Map(detail.messages.map((message) => [message.id, message]));
  for (const receipt of receipts) {
    // Die SECURITY-DEFINER-Projektion ist die einzige Quelle fuer neutrale
    // REJECTED-Metadaten. BLOCKED wird DB-seitig nie ausgegeben; unbekannte
    // Werte werden zusaetzlich fail-closed verworfen.
    if (receipt.decision !== 'REJECTED' || receipt.downloadAllowed) continue;
    const message = messageById.get(receipt.messageId);
    if (!message || message.attachments.some((item) => item.id === receipt.attachmentId)) continue;
    message.attachments.push({
      id: receipt.attachmentId,
      originalName: receipt.originalName,
      mimeType: receipt.mimeType,
      sizeBytes: receipt.sizeBytes.toString(),
      scanStatus: 'CLEAN',
      decision: 'REJECTED',
      acceptedDocumentId: null,
      rejectionReason: receipt.rejectionReason,
      downloadHref: null,
    });
  }
  return detail;
}

export async function getStaffInboxThreadTx(
  tx: TxClient,
  session: StaffSession,
  threadId: string,
): Promise<InboxThreadDetail | null> {
  const row = await tx.portalInboxThread.findFirst({
    where: { id: threadId, tenantId: session.user.tenantId },
    select: DETAIL_SELECT,
  });
  if (!row) return null;
  await assertStaffInboxClientTx(tx, session, row.clientId);
  return detailFromRowTx(tx, row, 'staff');
}

export async function countPortalInboxNeedsClientTx(
  tx: TxClient,
  actor: { tenantId: string; clientId: string; contactId: string },
): Promise<number> {
  await assertActivePortalInboxIdentityTx(tx, actor);
  return tx.portalInboxThread.count({
    where: {
      tenantId: actor.tenantId,
      clientId: actor.clientId,
      status: 'OPEN',
      attention: 'CLIENT',
    },
  });
}
