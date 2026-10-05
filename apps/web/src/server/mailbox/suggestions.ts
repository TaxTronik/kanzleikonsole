import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

const ADDRESS_RE = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?/gi;
// Grenzt die IN-Liste je Abfrage ein (ein Parameter je Adresse); sehr lange
// Empfängerlisten werden in mehreren Abfragen statt einer übergroßen gesucht.
const ADDRESSES_PER_QUERY = 500;

/** Exakte, kleingeschriebene Adressen aus unbestätigten Absender-/Empfängerangaben. */
export function inboundAddresses(sender: string, recipients: string): string[] {
  return [
    ...new Set(
      ((sender + ' ' + recipients).match(ADDRESS_RE) ?? []).map((address) => address.toLowerCase()),
    ),
  ];
}

export interface InboundSuggestionScope {
  tenantId: string;
  /** Sichtbarkeitsregel des Mitarbeiters (`accessibleClientsWhereFor`). */
  accessWhere: Prisma.ClientWhereInput;
}

export type InboundSuggestion = { id: string; name: string };

/**
 * Unbestätigte Zuordnungsvorschläge je Nachricht: exakte Übereinstimmung einer
 * Absender-/Empfängeradresse mit einer aktiven Kontaktadresse (citext, also
 * ohne Groß-/Kleinschreibung) eines zugänglichen, aktiven Mandats. Die
 * Zuordnung läuft in der Datenbank statt über alle Kontakte im Speicher.
 * Ein Vorschlag wählt nie selbst einen Mandanten aus.
 */
export async function suggestInboundClientsTx(
  tx: TxClient,
  scope: InboundSuggestionScope,
  messages: ReadonlyArray<{ id: string; sender: string; recipients: string }>,
): Promise<Map<string, InboundSuggestion[]>> {
  const perMessage = messages.map((m) => ({
    id: m.id,
    addresses: inboundAddresses(m.sender, m.recipients),
  }));
  const all = [...new Set(perMessage.flatMap((m) => m.addresses))];
  const clientsByAddress = new Map<string, Map<string, InboundSuggestion>>();
  for (let offset = 0; offset < all.length; offset += ADDRESSES_PER_QUERY) {
    const rows = await tx.clientContact.findMany({
      where: {
        active: true,
        email: { in: all.slice(offset, offset + ADDRESSES_PER_QUERY) },
        client: {
          AND: [
            scope.accessWhere,
            {
              tenantId: scope.tenantId,
              allowActive: true,
              anonymizedAt: null,
              mandateEndedAt: null,
            },
          ],
        },
      },
      select: { email: true, client: { select: { id: true, name: true } } },
    });
    for (const row of rows) {
      const key = row.email.toLowerCase();
      const clients = clientsByAddress.get(key) ?? new Map<string, InboundSuggestion>();
      clients.set(row.client.id, { id: row.client.id, name: row.client.name });
      clientsByAddress.set(key, clients);
    }
  }
  const result = new Map<string, InboundSuggestion[]>();
  for (const message of perMessage) {
    const clients = new Map<string, InboundSuggestion>();
    for (const address of message.addresses) {
      for (const client of clientsByAddress.get(address)?.values() ?? []) {
        clients.set(client.id, client);
      }
    }
    result.set(
      message.id,
      [...clients.values()].sort(
        (a, b) => a.name.localeCompare(b.name, 'de') || a.id.localeCompare(b.id),
      ),
    );
  }
  return result;
}
