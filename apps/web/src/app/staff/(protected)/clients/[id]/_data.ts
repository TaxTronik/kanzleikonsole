import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { MANAGED_DOC_SELECT, toManagedDoc } from '@/server/documents/managed-docs';
import { descendants } from '@/components/document-browser-utils';
import { buildFolderDocumentCounts } from '@/components/document-explorer-performance';
import { isUuid } from '@/lib/uuid';
import { readRequestCreationOptionsTx } from '@/server/request-creation-options';
import type { ModuleConfig } from '@/server/settings/modules';

export const CLIENT_REQUESTS_CAP = 50;
export const CLIENT_DOCUMENTS_PAGE_SIZE = 50;
export const CLIENT_DOCUMENTS_SEARCH_MAX = 200;

// =============================================================================
// Mandanten-Cockpit in drei Transaktionen (Review-Befund P-07):
//   1. Kopf (blockierend): Mandant, Zuständige, Ansprechpartner, GwG-Status,
//      Zähler für Navigation/Onboarding, Custom-Felder und Anforderungsvorlagen.
//   2. Blöcke (gestreamt): Termine, Anforderungen, Wiedervorlagen, Workflows,
//      Telefonnotizen, Ordner und Übergaben — startet parallel zum Kopf.
//   3. Dokumente (gestreamt, loadClientDocumentsPage) — nach dem Kopf.
// Vorher liefen alle Abfragen nacheinander in EINER Transaktion, bevor das
// erste Byte kam. Jede Transaktion prüft den Zugriff selbst (Backstop).
// =============================================================================

/** Module, nach denen die Blockabfragen gewählt werden (abgeschaltet = keine Abfrage). */
export type CockpitModules = Pick<
  ModuleConfig,
  'taxNotices' | 'appointments' | 'workflows' | 'reminders' | 'binders' | 'handovers' | 'phoneNotes'
>;

/**
 * Positiver Tenant- und RESTRICTED-/Vertraulichkeits-Backstop in derselben
 * Transaktion wie die Daten. Layout, Seite und gestreamte Blöcke rendern
 * parallel; kein Loader darf allein auf den Layout-Guard bauen.
 */
async function accessibleClientWhereTx(
  tx: TxClient,
  ctx: TenantContext,
  session: StaffSession,
  clientId: string,
) {
  return {
    id: clientId,
    tenantId: ctx.tenantId,
    ...(await accessibleClientsWhereFor(tx, session)),
  };
}

export async function loadClientCockpitHeader(
  ctx: TenantContext,
  session: StaffSession,
  clientId: string,
) {
  return withTenantContext(ctx, async (tx) => {
    const client = await tx.client.findFirst({
      where: await accessibleClientWhereTx(tx, ctx, session, clientId),
      include: {
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
            requests: true,
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

    const [pendingChangeRequests, customDefs, customValues, requestCreationOptions] =
      await Promise.all([
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
        readRequestCreationOptionsTx(tx),
      ]);

    return {
      status: 'ok' as const,
      data: {
        client,
        pendingChangeRequests,
        customDefs,
        customValues,
        ...requestCreationOptions,
      },
    };
  });
}

const STAFF_OPTION_QUERY = {
  where: { active: true },
  orderBy: { fullName: 'asc' },
  select: { id: true, fullName: true },
} as const;

/**
 * Daten der gestreamten Blöcke in EINER Transaktion. `null`, wenn der Zugriff
 * (inzwischen) fehlt — die Blöcke rendern dann nichts. Abfragen abgeschalteter
 * Module entfallen.
 */
export async function loadClientCockpitBlocks(
  ctx: TenantContext,
  session: StaffSession,
  clientId: string,
  modules: CockpitModules,
  now: Date = new Date(),
) {
  return withTenantContext(ctx, async (tx) => {
    const accessible = await tx.client.findFirst({
      where: await accessibleClientWhereTx(tx, ctx, session, clientId),
      select: { id: true },
    });
    if (!accessible) return null;

    const [
      requests,
      taxDeadlines,
      upcomingAppointments,
      pendingAppointmentRequests,
      staffList,
      workflowInstances,
      reminders,
      phoneNotes,
      binders,
      handovers,
    ] = await Promise.all([
      tx.request.findMany({
        where: { clientId },
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
      }),
      modules.taxNotices
        ? tx.taxDeadline.findMany({
            where: {
              clientId,
              status: { in: ['PLANNED', 'REMINDED', 'IN_PROGRESS', 'OVERDUE'] },
            },
            orderBy: { dueDate: 'asc' },
            take: 12,
          })
        : Promise.resolve([]),
      modules.appointments
        ? tx.appointment.findMany({
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
          })
        : Promise.resolve([]),
      modules.appointments
        ? tx.appointmentRequest.findMany({
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
          })
        : Promise.resolve([]),
      // Mitarbeiterauswahl für Terminanfragen, Wiedervorlagen und Telefonnotizen.
      modules.appointments || modules.reminders || modules.phoneNotes
        ? tx.staffUser.findMany(STAFF_OPTION_QUERY)
        : Promise.resolve([]),
      modules.workflows
        ? tx.workflowInstance.findMany({
            where: { clientId, status: 'ACTIVE' },
            orderBy: { startedAt: 'desc' },
            take: 6,
            include: {
              items: { select: { id: true, doneAt: true, dueDate: true } },
            },
          })
        : Promise.resolve([]),
      modules.reminders
        ? tx.clientReminder.findMany({
            where: { clientId, archivedAt: null },
            orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueDate: 'asc' }],
            take: 50,
            include: {
              riskMarkings: { select: { id: true, analysisId: true }, take: 1 },
              assignees: { select: { staffId: true }, orderBy: { createdAt: 'asc' } },
            },
          })
        : Promise.resolve([]),
      modules.phoneNotes
        ? tx.phoneNote.findMany({
            where: { clientId },
            orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
            take: 20,
            include: {
              reminders: {
                orderBy: [{ doneAt: { sort: 'asc', nulls: 'first' } }, { dueDate: 'asc' }],
                select: { id: true, subject: true, dueDate: true, doneAt: true },
              },
            },
          })
        : Promise.resolve([]),
      modules.binders
        ? tx.pendingBinder.findMany({
            where: { clientId },
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
            take: 50,
          })
        : Promise.resolve([]),
      modules.handovers
        ? tx.clientHandover.findMany({
            where: { clientId },
            orderBy: [{ status: 'asc' }, { receivedAt: 'desc' }],
            take: 50,
          })
        : Promise.resolve([]),
    ]);

    return {
      requests,
      taxDeadlines,
      upcomingAppointments,
      pendingAppointmentRequests,
      staffList,
      workflowInstances,
      reminders,
      phoneNotes,
      binders,
      handovers,
    };
  });
}

export type ClientCockpitBlocks = NonNullable<Awaited<ReturnType<typeof loadClientCockpitBlocks>>>;

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

/** URL-Zustand der Dokumentliste im Mandanten-Tab. */
export interface ClientDocumentsQuery {
  page: number;
  deleted: boolean;
  /** 'all' | 'none' (ohne Ordner) | Ordner-ID (inkl. Unterordner) */
  folder: string;
  /** Titelsuche (Teilstring, ohne Groß-/Kleinschreibung) */
  q: string;
}

export function parseClientDocumentsFolder(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 'none') return 'none';
  return raw && isUuid(raw) ? raw : 'all';
}

export function parseClientDocumentsSearch(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? '').trim().slice(0, CLIENT_DOCUMENTS_SEARCH_MAX);
}

/**
 * Eine Seite der Mandanten-Dokumente. Ordner und Suche filtern serverseitig
 * über ALLE Dokumente des Mandanten (nicht nur die geladene Seite); Zählung und
 * Blättern laufen über die gefilterte Menge. Die Ordnerzähler gelten für alle
 * Dokumente des Aktiv-/Gelöscht-Zustands.
 */
export async function loadClientDocumentsPage(
  ctx: TenantContext,
  session: StaffSession,
  clientId: string,
  query: ClientDocumentsQuery,
) {
  return withTenantContext(ctx, async (tx) => {
    const accessWhere = await accessibleClientsWhereFor(tx, session);
    const accessibleClient = await tx.client.findFirst({
      where: { id: clientId, tenantId: ctx.tenantId, ...accessWhere },
      select: { id: true },
    });
    if (!accessibleClient) return null;

    const baseWhere = { tenantId: ctx.tenantId, clientId };
    const stateWhere = {
      ...baseWhere,
      deletedAt: query.deleted ? { not: null } : null,
    };
    const [folders, perFolder, datevDocument] = await Promise.all([
      tx.documentFolder.findMany({
        where: baseWhere,
        select: { id: true, name: true, parentId: true },
        orderBy: { name: 'asc' },
      }),
      tx.document.groupBy({
        by: ['folderId'],
        where: stateWhere,
        _count: { _all: true },
      }),
      tx.document.findFirst({
        where: {
          ...baseWhere,
          deletedAt: null,
          classification: { in: ['GOBD_INVOICE', 'GOBD_CONTRACT', 'GOBD_TAX'] },
        },
        select: { id: true },
      }),
    ]);

    // Unbekannte oder fremde Ordner-IDs fallen auf „Alle“ zurück.
    const folder =
      query.folder === 'none' || folders.some((candidate) => candidate.id === query.folder)
        ? query.folder
        : 'all';
    const q = query.q.trim().slice(0, CLIENT_DOCUMENTS_SEARCH_MAX);
    const documentWhere = {
      ...stateWhere,
      ...(folder === 'none'
        ? { folderId: null }
        : folder !== 'all'
          ? { folderId: { in: [...descendants(folders, folder)] } }
          : {}),
      ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}),
    };
    const totalCount = await tx.document.count({ where: documentWhere });

    const totalPages = Math.max(1, Math.ceil(totalCount / CLIENT_DOCUMENTS_PAGE_SIZE));
    const normalizedRequestedPage =
      Number.isSafeInteger(query.page) && query.page >= 1 ? query.page : 1;
    const page = Math.min(normalizedRequestedPage, totalPages);
    const skip = (page - 1) * CLIENT_DOCUMENTS_PAGE_SIZE;
    const rows = await tx.document.findMany({
      where: documentWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take: CLIENT_DOCUMENTS_PAGE_SIZE,
      select: MANAGED_DOC_SELECT,
    });

    const counts = buildFolderDocumentCounts(
      folders,
      perFolder.map((row) => ({ folderId: row.folderId, count: row._count._all })),
    );
    return {
      folders,
      documents: rows.map(toManagedDoc),
      totalCount,
      totalPages,
      page,
      from: totalCount === 0 ? 0 : skip + 1,
      to: skip + rows.length,
      hasDatevDocuments: datevDocument !== null,
      deleted: query.deleted,
      folder,
      q,
      folderCounts: {
        all: perFolder.reduce((sum, row) => sum + row._count._all, 0),
        none: counts.withoutFolder,
        byId: Object.fromEntries(counts.byId),
      },
    };
  });
}

export type ClientDocumentsPageData = NonNullable<
  Awaited<ReturnType<typeof loadClientDocumentsPage>>
>;
