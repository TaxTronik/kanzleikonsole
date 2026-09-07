import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { MANAGED_DOC_SELECT, toManagedDoc } from '@/server/documents/managed-docs';
import { readRequestCreationOptionsTx } from '@/server/request-creation-options';

export const CLIENT_REQUESTS_CAP = 50;
export const CLIENT_DOCUMENTS_PAGE_SIZE = 50;

export async function loadClientDashboard(
  ctx: TenantContext,
  session: StaffSession,
  clientId: string,
  now: Date = new Date(),
) {
  return withTenantContext(ctx, async (tx) => {
    // Positiver Tenant- und RESTRICTED-/Vertraulichkeits-Backstop in derselben
    // Transaktion wie die Cockpit-Daten. Layout und Page können parallel
    // rendern; der Loader darf deshalb nicht allein auf den Layout-Guard bauen.
    const accessWhere = await accessibleClientsWhereFor(tx, session);
    const client = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, ...accessWhere },
      include: {
        requests: {
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          take: CLIENT_REQUESTS_CAP,
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            dueAt: true,
            responses: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            },
          },
        },
        contacts: { where: { active: true }, orderBy: { fullName: 'asc' } },
        gwgChecks: { orderBy: { createdAt: 'desc' }, take: 1 },
        responsibilities: {
          include: { staff: { select: { id: true, fullName: true } } },
        },
        _count: {
          select: {
            poas: true,
            gwgInvites: true,
            gwgChecks: true,
          },
        },
      },
    });
    if (!client) {
      const exists = await tx.client.findUnique({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      return exists ? ({ status: 'forbidden' } as const) : ({ status: 'not_found' } as const);
    }

    const [
      phoneNotes,
      taxDeadlines,
      pendingChangeRequests,
      customDefs,
      customValues,
      staffList,
      workflowInstances,
      reminders,
      binders,
      upcomingAppointments,
      pendingAppointmentRequests,
      handovers,
      requestCreationOptions,
    ] = await Promise.all([
      tx.phoneNote.findMany({
        where: { clientId },
        orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
        take: 20,
        include: {
          reminders: {
            orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueDate: 'asc' }],
            select: { id: true, subject: true, dueDate: true, doneAt: true },
          },
        },
      }),
      tx.taxDeadline.findMany({
        where: {
          clientId,
          status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] },
        },
        orderBy: { dueDate: 'asc' },
        take: 12,
      }),
      tx.clientMasterChangeRequest.count({
        where: { clientId, status: 'PENDING' },
      }),
      tx.clientCustomFieldDef.findMany({
        where: { active: true },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
      tx.clientCustomFieldValue.findMany({
        where: { clientId },
      }),
      tx.staffUser.findMany({
        where: { active: true },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true },
      }),
      tx.workflowInstance.findMany({
        where: { clientId, status: 'ACTIVE' },
        orderBy: { startedAt: 'desc' },
        take: 6,
        include: {
          items: { select: { id: true, doneAt: true, dueDate: true } },
        },
      }),
      tx.clientReminder.findMany({
        where: { clientId, archivedAt: null },
        orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueDate: 'asc' }],
        take: 50,
        include: {
          riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
          assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
        },
      }),
      tx.pendingBinder.findMany({
        where: { clientId },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: 50,
      }),
      tx.appointment.findMany({
        where: { clientId, status: { not: 'CANCELLED' }, endsAt: { gte: now } },
        orderBy: { startsAt: 'asc' },
        take: 5,
        select: {
          id: true,
          title: true,
          startsAt: true,
          endsAt: true,
          location: true,
          status: true,
          owner: { select: { id: true, fullName: true } },
        },
      }),
      tx.appointmentRequest.findMany({
        where: { clientId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          subject: true,
          notes: true,
          createdAt: true,
          preferredStaffId: true,
          proposedSlots: true,
          createdByContactRel: { select: { fullName: true } },
        },
      }),
      tx.clientHandover.findMany({
        where: { clientId },
        orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
        take: 50,
      }),
      readRequestCreationOptionsTx(tx),
    ]);

    return {
      status: 'ok' as const,
      data: {
        client,
        phoneNotes,
        taxDeadlines,
        pendingChangeRequests,
        customDefs,
        customValues,
        staffList,
        workflowInstances,
        reminders,
        binders,
        upcomingAppointments,
        pendingAppointmentRequests,
        handovers,
        ...requestCreationOptions,
      },
    };
  });
}

export type ClientDashboardData = Extract<
  Awaited<ReturnType<typeof loadClientDashboard>>,
  { status: 'ok' }
>['data'];

export function parseClientDocumentsPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d+$/.test(raw)) return 1;
  const page = Number(raw);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

export function parseClientDocumentsDeleted(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === '1';
}

export async function loadClientDocumentsPage(
  ctx: TenantContext,
  session: StaffSession,
  clientId: string,
  requestedPage: number,
  deleted: boolean,
) {
  return withTenantContext(ctx, async (tx) => {
    const accessWhere = await accessibleClientsWhereFor(tx, session);
    const accessibleClient = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, ...accessWhere },
      select: { id: true },
    });
    if (!accessibleClient) return null;

    const baseWhere = { tenantId: ctx.tenantId, clientId };
    const documentWhere = {
      ...baseWhere,
      deletedAt: deleted ? { not: null } : null,
    };
    const [folders, totalCount, datevDocument] = await Promise.all([
      tx.documentFolder.findMany({
        where: baseWhere,
        select: { id: true, name: true, parentId: true },
        orderBy: { name: 'asc' },
      }),
      tx.document.count({ where: documentWhere }),
      tx.document.findFirst({
        where: {
          ...baseWhere,
          deletedAt: null,
          classification: { in: ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'] },
        },
        select: { id: true },
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(totalCount / CLIENT_DOCUMENTS_PAGE_SIZE));
    const normalizedRequestedPage =
      Number.isSafeInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
    const page = Math.min(normalizedRequestedPage, totalPages);
    const skip = (page - 1) * CLIENT_DOCUMENTS_PAGE_SIZE;
    const rows = await tx.document.findMany({
      where: documentWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: CLIENT_DOCUMENTS_PAGE_SIZE,
      select: MANAGED_DOC_SELECT,
    });

    return {
      folders,
      documents: rows.map(toManagedDoc),
      totalCount,
      totalPages,
      page,
      from: totalCount === 0 ? 0 : skip + 1,
      to: skip + rows.length,
      hasDatevDocuments: datevDocument !== null,
      deleted,
    };
  });
}

export type ClientDocumentsPageData = NonNullable<
  Awaited<ReturnType<typeof loadClientDocumentsPage>>
>;
