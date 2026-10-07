import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001 (Entwurf). Portal-Kontakte dürfen
// interne Kanzleikennungen nicht über Treffer/Kein-Treffer auslesen.
export function inboxMetadataSearch(
  query: string,
  surface: 'portal' | 'staff',
): Prisma.PortalInboxThreadWhereInput[] {
  if (!query) return [];
  const shared: Prisma.PortalInboxThreadWhereInput[] = [
    { subject: { contains: query, mode: 'insensitive' } },
    { client: { name: { contains: query, mode: 'insensitive' } } },
  ];
  if (surface === 'portal') return shared;
  return [
    ...shared,
    { client: { datevNo: { contains: query, mode: 'insensitive' } } },
    { client: { addisonNo: { contains: query, mode: 'insensitive' } } },
  ];
}

/** Höchstzahl der Kandidaten; darüber sucht die Staff-Liste wie bisher ohne Vorauswahl. */
export const STAFF_INBOX_SEARCH_CANDIDATE_LIMIT = 10_000;

/**
 * Review-Finding P-10: Stufe 1 der Staff-Posteingangssuche. Unter RLS darf
 * PostgreSQL `ILIKE` nicht als Indexbedingung nutzen; die Suche ließ deshalb
 * jede Thread-Zeile des Tenants durch die Staff-Policy laufen.
 * `app.portal_inbox_staff_search_candidates` (SECURITY DEFINER, Tenant nur aus
 * dem Kontext) findet die Treffer derselben Felder und desselben Musters wie
 * `inboxMetadataSearch(query, 'staff')` über den Trigram-Index und liefert nur
 * Threads, die die Staff-Policy sichtbar macht. Die Liste lädt danach wie
 * bisher unter RLS, eingeschränkt auf diese IDs.
 *
 * `null` bei mehr als `STAFF_INBOX_SEARCH_CANDIDATE_LIMIT` Treffern: dann ohne
 * Vorauswahl suchen (Treffer und Zähler sind in beiden Fällen dieselben).
 */
export async function staffInboxSearchCandidatesTx(
  tx: TxClient,
  query: string,
): Promise<string[] | null> {
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT thread_id::text AS id, ueberlauf
      FROM app.portal_inbox_staff_search_candidates(
        ${query},
        ${STAFF_INBOX_SEARCH_CANDIDATE_LIMIT}::int
      )
  `;
  if (rows.some((row) => row.ueberlauf)) return null;
  return rows.flatMap((row) => (row.id ? [row.id] : []));
}
