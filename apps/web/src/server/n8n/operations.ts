import { withSystemContext } from '@taxtronik/db';
import { prismaOwner } from '@/server/db/prisma-owner';
import { readModules } from '@/server/settings/modules';
import { evidenceService } from '@/server/container';
import { notify } from '@/server/notifications/service';
import { receiveResearchResult } from '@/server/risk';
import {
  claimN8nCallbackReceipt,
  N8N_CALLBACK_OPERATIONS,
  type N8nCallbackReceiptKey,
} from '@/server/n8n/callback-receipts';

export async function getOverdueRequestsForTenant(tenantId: string, now = new Date()) {
  const rows = await prismaOwner.request.findMany({
    where: {
      tenantId,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      dueAt: { not: null, lt: now },
    },
    include: {
      client: {
        include: {
          contacts: {
            where: { active: true, notificationsEnabled: true, email: { not: '' } },
            take: 1,
            orderBy: { fullName: 'asc' },
          },
        },
      },
    },
  });

  const requests = rows
    .filter((row) => row.client.contacts.length > 0)
    .map((row) => {
      const contact = row.client.contacts[0]!;
      const daysOverdue = Math.floor(
        (now.getTime() - (row.dueAt as Date).getTime()) / (24 * 60 * 60 * 1000),
      );
      return {
        id: row.id,
        tenantId: row.tenantId,
        clientName: row.client.name,
        contactEmail: contact.email,
        contactName: contact.fullName,
        signerEmail: contact.email,
        title: row.title,
        dueAt: row.dueAt,
        daysOverdue,
      };
    });

  return { count: requests.length, requests };
}

export async function getExpiringGwgChecks(tenantId: string, withinDays: number, now = new Date()) {
  const cutoff = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const checks = await prismaOwner.gwgCheck.findMany({
    where: {
      tenantId,
      status: 'VERIFIED',
      validUntil: { not: null, lte: cutoff },
    },
    include: { client: { select: { name: true } } },
    orderBy: { validUntil: 'asc' },
  });

  return {
    count: checks.length,
    checks: checks.map((check) => ({
      id: check.id,
      tenantId: check.tenantId,
      clientId: check.clientId,
      clientName: check.client.name,
      validUntil: check.validUntil,
      riskLevel: check.riskLevel,
    })),
  };
}

export async function getRequestDetailForTenant(tenantId: string, id: string) {
  const request = await prismaOwner.request.findFirst({
    where: { id, tenantId },
    include: {
      client: {
        include: {
          contacts: {
            where: { active: true, notificationsEnabled: true, email: { not: '' } },
            orderBy: { fullName: 'asc' },
          },
        },
      },
    },
  });
  if (!request) return null;

  const notifiableContacts = request.client.contacts.map((candidate) => ({
    id: candidate.id,
    fullName: candidate.fullName,
    email: candidate.email,
  }));

  return {
    id: request.id,
    tenantId: request.tenantId,
    title: request.title,
    description: request.description,
    priority: request.priority,
    status: request.status,
    dueAt: request.dueAt,
    clientName: request.client.name,
    notifiableContacts,
  };
}

export interface InboundRequestEmailInput {
  requestId: string;
  fromEmail: string;
  message: string;
}

export async function handleInboundRequestEmail(
  tenantId: string,
  input: InboundRequestEmailInput,
  callbackReceipt?: N8nCallbackReceiptKey,
): Promise<
  | { status: 200; duplicate: boolean }
  | { status: 403; error: 'inbound_mail_disabled' }
  | { status: 404; error: 'request_not_found_or_closed' }
  | { status: 422; error: 'unknown_sender' }
> {
  const modules = await readModules({ tenantId, actorId: null, actorType: 'SYSTEM' });
  if (!modules.inboundMail) {
    return { status: 403, error: 'inbound_mail_disabled' };
  }

  return withSystemContext(tenantId, async (tx) => {
    const request = await tx.request.findFirst({
      where: {
        id: input.requestId,
        tenantId,
        status: { in: ['OPEN', 'IN_PROGRESS', 'RESPONDED'] },
      },
      select: { id: true, title: true, clientId: true, createdByStaff: true },
    });
    if (!request) return { status: 404 as const, error: 'request_not_found_or_closed' as const };

    const normalizedEmail = input.fromEmail.toLowerCase();
    const contact = await tx.clientContact.findFirst({
      where: { clientId: request.clientId, email: normalizedEmail, active: true },
      select: { id: true },
    });
    if (!contact) return { status: 422 as const, error: 'unknown_sender' as const };

    if (callbackReceipt) {
      const receipt = await claimN8nCallbackReceipt(tx, {
        ...callbackReceipt,
        tenantId,
        operation: N8N_CALLBACK_OPERATIONS.inboundMail,
      });
      if (receipt.duplicate) return { status: 200 as const, duplicate: true };
    }

    await tx.requestResponse.create({
      data: {
        requestId: input.requestId,
        authorType: 'CLIENT_CONTACT',
        authorId: contact.id,
        message: input.message,
      },
    });
    await tx.request.update({
      where: { id: input.requestId },
      data: { status: 'RESPONDED' },
    });

    await notify(tx, {
      tenantId,
      staffId: request.createdByStaff,
      kind: 'REQUEST_RESPONDED',
      title: `${request.title} — Antwort per E-Mail`,
      body: input.message.slice(0, 200) + (input.message.length > 200 ? '…' : ''),
      href: `/staff/requests/${input.requestId}`,
      resourceType: 'request',
      resourceId: input.requestId,
    });

    await evidenceService.record(tx, {
      tenantId,
      actorType: 'CLIENT_CONTACT',
      actorId: contact.id,
      action: 'request.response.inbound_mail',
      resourceType: 'request',
      resourceId: input.requestId,
      after: { via: 'inbound_mail', fromEmail: normalizedEmail },
    });

    return { status: 200 as const, duplicate: false };
  });
}

export interface N8nResearchResultInput {
  researchRequestId?: string;
  title?: string;
  body: string;
  source?: string;
}

/** Erzwingt vor dem Owner-Lookup in receiveResearchResult die Tenant-Bindung
 * der opaken Korrelations-ID. */
export async function receiveResearchResultForTenant(
  tenantId: string,
  input: N8nResearchResultInput,
  callbackReceipt?: N8nCallbackReceiptKey,
) {
  if (input.researchRequestId) {
    const correlated = await prismaOwner.riskResearchRequest.findFirst({
      where: { id: input.researchRequestId, tenantId },
      select: { id: true },
    });
    if (!correlated) return null;
  }

  return receiveResearchResult(
    { ...input, tenantId },
    callbackReceipt
      ? {
          ...callbackReceipt,
          tenantId,
          operation: N8N_CALLBACK_OPERATIONS.researchResult,
        }
      : undefined,
  );
}
