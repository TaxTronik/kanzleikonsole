// =============================================================================
// Prisma-Filter aus der Mandanten-Sichtbarkeitsregel.
//
// `accessibleClientsWhereFor` (rbac.ts) liefert die Regel als positive
// Bedingung auf `client`; die Helfer hier hängen sie an mandantengebundene
// Modelle. PostgreSQL filtert damit direkt über `client` und
// `client_responsibility`, statt dass die App die gesperrten Mandanten-IDs lädt
// und als NOT-IN-Liste an jede Abfrage hängt (im RESTRICTED-Modus nahezu der
// gesamte Bestand als Parameter).
//
// Reine Funktionen ohne Session-/DB-Import: Loader, Widgets und ihre Unit-Tests
// brauchen dafür kein Mock von rbac.ts.
// =============================================================================

import type { Prisma } from '@prisma/client';

/** Ergebnis von `accessibleClientsWhereFor`; `{}` heißt: keine Einschränkung (Admin/Partner). */
export type ClientAccessWhere = Prisma.ClientWhereInput;

function restricts(where: Prisma.ClientWhereInput | undefined): where is Prisma.ClientWhereInput {
  return where !== undefined && Object.keys(where).length > 0;
}

/**
 * `client`-Filter für Modelle mit Pflicht-Mandant. Weitere Mandantenbedingungen
 * (Zuständigkeit, Suchbegriff) werden im SELBEN Schlüssel per AND verbunden: ein
 * zweiter `client`-Schlüssel im Objektliteral würde den Zugriffsfilter sonst still
 * überschreiben.
 */
export function clientAccessFilter(
  access: ClientAccessWhere | undefined,
  ...more: Array<Prisma.ClientWhereInput | undefined>
): { client?: Prisma.ClientWhereInput } {
  const parts = [access, ...more].filter(restricts);
  if (parts.length === 0) return {};
  return { client: parts.length === 1 ? parts[0] : { AND: parts } };
}

/**
 * Für Modelle mit nullable `clientId` (Termine, Telefonzettel, Zeiteinträge,
 * Kanzlei-Dokumente, interne Wiedervorlagen): Datensätze ohne Mandantenbezug
 * bleiben sichtbar. Liefert ein `OR`; neben weiteren OR-Bedingungen im `AND`
 * einsetzen.
 */
export function optionalClientAccessFilter(access: ClientAccessWhere | undefined): {
  OR?: Array<{ clientId: null } | { client: Prisma.ClientWhereInput }>;
} {
  return restricts(access) ? { OR: [{ clientId: null }, { client: access }] } : {};
}
