import type { Prisma } from '@prisma/client';
import type { ClientAccessWhere } from '@/server/auth/client-access-filter';

/**
 * TimeEntry hat keine Prisma-Relation zum Mandanten (`time_entry.client_id`
 * ohne Fremdschlüssel), daher kein Relationsfilter wie in den übrigen Listen.
 * Die Seite lädt nur die eigenen Einträge des Tages und prüft die wenigen dort
 * referenzierten Mandanten gegen die Sichtbarkeitsregel.
 */
export function buildTimePageClientQueries(ids: string[], clientAccess: ClientAccessWhere) {
  const visibleWhere: Prisma.ClientWhereInput = { AND: [{ id: { in: ids } }, clientAccess] };
  // Vorhandene, aber gesperrte Mandanten; Admin/Partner (Regel `{}`) sperrt nichts.
  const hiddenWhere: Prisma.ClientWhereInput | null =
    Object.keys(clientAccess).length > 0 ? { id: { in: ids }, NOT: clientAccess } : null;
  return { visibleWhere, hiddenWhere };
}

/** Blendet Einträge gesperrter Mandanten aus; interne Zeiten (ohne Mandant) bleiben. */
export function withoutHiddenClients<T extends { clientId: string | null }>(
  entries: readonly T[],
  hiddenClientIds: ReadonlySet<string>,
): T[] {
  return entries.filter((entry) => entry.clientId === null || !hiddenClientIds.has(entry.clientId));
}
