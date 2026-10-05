// =============================================================================
// Serverseitige Mandantenauswahl (ClientCombobox + GET /api/staff/clients/search)
//
// Ersetzt das frühere Laden des gesamten Bestands (oder der ersten 500
// Mandanten) in jede Auswahlliste. Jede Abfrage kombiniert:
//   1. den Tenant der Session (zusätzlich zu RLS),
//   2. dieselbe Sichtbarkeitsregel wie alle Mandantenlisten
//      (`accessibleClientsWhereFor`: Admin/Partner, OPEN + vertraulich,
//      RESTRICTED),
//   3. die Lebenszyklusfilter der jeweiligen Auswahl (nur verengend).
// Treffer sind gedeckelt; Suchbegriffe werden weder auditiert noch geloggt.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { accessibleClientsWhereFor } from '@/server/auth/rbac';
import { isUuid } from '@/lib/uuid';
import {
  CLIENT_PICKER_LIMIT,
  type ClientPickerFilter,
  type ClientPickerOption,
  type ClientPickerRequest,
  type ClientPickerResult,
} from '@/lib/client-picker';

const FILTER_WHERE: Record<ClientPickerFilter, Prisma.ClientWhereInput> = {
  active: { allowActive: true },
  notEnded: { mandateEndedAt: null },
  notAnonymized: { anonymizedAt: null },
  activeWorkflow: { workflowInstances: { some: { status: 'ACTIVE' } } },
};

const OPTION_SELECT = {
  id: true,
  name: true,
  datevNo: true,
  addisonNo: true,
  allowActive: true,
  mandateEndedAt: true,
} satisfies Prisma.ClientSelect;

// Freigegebene Mandanten zuerst (wie die bisherige Anforderungssuche), dann
// Name; die ID macht die Reihenfolge bei Namensgleichheit stabil.
const OPTION_ORDER: Prisma.ClientOrderByWithRelationInput[] = [
  { allowActive: 'desc' },
  { name: 'asc' },
  { id: 'asc' },
];

type OptionRow = Prisma.ClientGetPayload<{ select: typeof OPTION_SELECT }>;

function toOption(row: OptionRow): ClientPickerOption {
  return {
    id: row.id,
    name: row.name,
    datevNo: row.datevNo,
    addisonNo: row.addisonNo,
    allowActive: row.allowActive,
    mandateEnded: row.mandateEndedAt !== null,
  };
}

/** Prisma `contains` maskiert LIKE-Metazeichen nicht; „50%" soll wörtlich treffen. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, (match) => `\\${match}`);
}

/** Sichtbarkeit + Tenant + Lebenszyklusfilter einer Auswahl. */
export async function clientPickerWhereTx(
  tx: TxClient,
  session: StaffSession,
  filters: readonly ClientPickerFilter[],
): Promise<Prisma.ClientWhereInput> {
  return {
    AND: [
      { tenantId: session.user.tenantId },
      await accessibleClientsWhereFor(tx, session),
      ...filters.map((filter) => FILTER_WHERE[filter]),
    ],
  };
}

function narrowingWhere(query: string, staffId: string): Prisma.ClientWhereInput {
  if (!query) {
    // Ohne Suchbegriff nur eigene Zuordnungen (jede Rolle) vorschlagen statt
    // eines alphabetischen Bestandsausschnitts.
    return { responsibilities: { some: { staffId } } };
  }
  const term = escapeLikePattern(query);
  return {
    OR: [
      { name: { contains: term, mode: 'insensitive' } },
      { datevNo: { contains: term, mode: 'insensitive' } },
      { addisonNo: { contains: term, mode: 'insensitive' } },
    ],
  };
}

export async function searchClientPickerTx(
  tx: TxClient,
  session: StaffSession,
  request: ClientPickerRequest,
): Promise<ClientPickerResult> {
  const query = request.query.trim();
  const rows = await tx.client.findMany({
    where: {
      AND: [
        await clientPickerWhereTx(tx, session, request.filters),
        narrowingWhere(query, session.user.staffId),
      ],
    },
    orderBy: OPTION_ORDER,
    take: CLIENT_PICKER_LIMIT + 1,
    select: OPTION_SELECT,
  });
  return {
    clients: rows.slice(0, CLIENT_PICKER_LIMIT).map(toOption),
    limited: rows.length > CLIENT_PICKER_LIMIT,
    mode: query ? 'search' : 'assigned',
  };
}

/**
 * Lädt Anzeigedaten vorausgewählter Mandanten (Bearbeiten, Filter, bekannte
 * Anrufer). Nicht sichtbare oder nicht passende IDs fehlen in der Map — ihr
 * Name wird nie ausgeliefert.
 */
export async function loadClientPickerOptionsTx(
  tx: TxClient,
  session: StaffSession,
  ids: ReadonlyArray<string | null | undefined>,
  filters: readonly ClientPickerFilter[] = [],
): Promise<Map<string, ClientPickerOption>> {
  const wanted = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && isUuid(id))),
  ];
  if (wanted.length === 0) return new Map();
  const rows = await tx.client.findMany({
    where: { AND: [await clientPickerWhereTx(tx, session, filters), { id: { in: wanted } }] },
    select: OPTION_SELECT,
  });
  return new Map(rows.map((row) => [row.id, toOption(row)]));
}

/** Einzelner Vorauswahl-Eintrag; `null`, wenn nicht sichtbar oder unpassend. */
export async function loadClientPickerOptionTx(
  tx: TxClient,
  session: StaffSession,
  id: string | null | undefined,
  filters: readonly ClientPickerFilter[] = [],
): Promise<ClientPickerOption | null> {
  if (!id) return null;
  return (await loadClientPickerOptionsTx(tx, session, [id], filters)).get(id) ?? null;
}

/** Für Leerzustände: gibt es überhaupt einen auswählbaren Mandanten? */
export async function hasClientPickerOptionTx(
  tx: TxClient,
  session: StaffSession,
  filters: readonly ClientPickerFilter[] = [],
): Promise<boolean> {
  const row = await tx.client.findFirst({
    where: await clientPickerWhereTx(tx, session, filters),
    select: { id: true },
  });
  return row !== null;
}
