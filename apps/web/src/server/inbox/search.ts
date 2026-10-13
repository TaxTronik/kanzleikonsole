import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { InboxTopic } from './constants';

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

/**
 * Höchstzahl der Treffer einer Staff-Suche (Review-Finding P-10, Welle 15).
 * Darüber zeigt die Liste die jüngsten Treffer mit dem Hinweis „Mehr als N
 * Treffer – Suche verfeinern“; Zählung und Laden unter RLS bleiben damit
 * begrenzt.
 */
export const STAFF_INBOX_SEARCH_CANDIDATE_LIMIT = 500;

/** Listenfilter, die schon die Kandidatensuche anwendet (dieselben wie die Liste). */
export interface StaffInboxSearchFilters {
  topic?: InboxTopic;
  status?: 'OPEN' | 'RESOLVED';
  attention?: 'STAFF' | 'CLIENT' | 'NONE';
  scope: 'mine' | 'team' | 'all';
}

export interface InboxSearchCandidates {
  /** IDs der jüngsten Treffer, höchstens `STAFF_INBOX_SEARCH_CANDIDATE_LIMIT`. */
  ids: string[];
  /** Es gibt mehr Treffer als die Grenze; ältere fehlen in `ids`. */
  truncated: boolean;
}

/**
 * Review-Finding P-10: Stufe 1 der Staff-Posteingangssuche. Unter RLS darf
 * PostgreSQL `ILIKE` nicht als Indexbedingung nutzen; die Suche ließ deshalb
 * jede Thread-Zeile des Tenants durch die Staff-Policy laufen.
 * `app.portal_inbox_staff_search_candidates_v2` (SECURITY DEFINER, Tenant und
 * Bearbeiter nur aus dem Kontext) findet die Treffer derselben Felder, desselben
 * Musters (`inboxMetadataSearch(query, 'staff')`) und derselben Listenfilter
 * über die Trigram-Indizes und liefert nur Threads, die die Staff-Policy
 * sichtbar macht, und davon die jüngsten bis zur Grenze. Die Liste lädt danach
 * unter RLS mit allen Filtern, eingeschränkt auf diese IDs.
 *
 * Welle 15: Bis dahin entfiel die Vorauswahl ab 10.000 Treffern und die Liste
 * suchte wieder unter RLS (100.000 Threads: rund zwei Minuten).
 */
export async function staffInboxSearchCandidatesTx(
  tx: TxClient,
  query: string,
  filters: StaffInboxSearchFilters,
): Promise<InboxSearchCandidates> {
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT thread_id::text AS id, ueberlauf
      FROM app.portal_inbox_staff_search_candidates_v2(
        ${query},
        ${filters.topic ?? null}::text,
        ${filters.status ?? null}::text,
        ${filters.attention ?? null}::text,
        ${filters.scope},
        ${STAFF_INBOX_SEARCH_CANDIDATE_LIMIT}::int
      )
  `;
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
    truncated: rows.some((row) => row.ueberlauf),
  };
}

/**
 * Höchstzahl der Treffer einer Portalsuche (P-10, Welle 15); darüber zeigt das
 * Portal die jüngsten Treffer mit dem Hinweis „Mehr als N Treffer – Suche
 * verfeinern“.
 */
export const PORTAL_INBOX_SEARCH_CANDIDATE_LIMIT = 500;

/**
 * Review-Finding P-10, Welle 15: Stufe 1 der Portalsuche im Posteingang.
 * `app.portal_inbox_contact_search_candidates` (SECURITY DEFINER) bindet Tenant
 * und Kontakt an den Kontext, leitet den Mandanten ausschließlich aus dem
 * Kontakt ab (wie die Kontakt-Policy) und findet die jüngsten Treffer derselben
 * Felder (`inboxMetadataSearch(query, 'portal')`: Betreff, eigener
 * Mandantenname) und Filter. Unter RLS lief vorher jede Thread-Zeile des
 * Mandanten durch die Kontakt-Policy, bevor ILIKE filtern durfte.
 */
export async function portalInboxSearchCandidatesTx(
  tx: TxClient,
  query: string,
  filters: Omit<StaffInboxSearchFilters, 'scope'>,
): Promise<InboxSearchCandidates> {
  const rows = await tx.$queryRaw<Array<{ id: string | null; ueberlauf: boolean }>>`
    SELECT thread_id::text AS id, ueberlauf
      FROM app.portal_inbox_contact_search_candidates(
        ${query},
        ${filters.topic ?? null}::text,
        ${filters.status ?? null}::text,
        ${filters.attention ?? null}::text,
        ${PORTAL_INBOX_SEARCH_CANDIDATE_LIMIT}::int
      )
  `;
  return {
    ids: rows.flatMap((row) => (row.id ? [row.id] : [])),
    truncated: rows.some((row) => row.ueberlauf),
  };
}

const CURSOR_PATTERN =
  /^(\d{1,15})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Position in der Trefferliste (letzte Aktivität absteigend, dann ID absteigend). */
export interface InboxCursor {
  lastMessageAt: Date;
  id: string;
}

/** Keyset-Cursor der Staff-Suche: `<Millisekunden>_<Thread-ID>`. */
export function encodeInboxCursor(row: InboxCursor): string {
  return `${row.lastMessageAt.getTime()}_${row.id}`;
}

/** Ungültige oder manipulierte Cursor beginnen auf der ersten Seite. */
export function parseInboxCursor(value: string | undefined): InboxCursor | null {
  const match = CURSOR_PATTERN.exec((value ?? '').trim().toLowerCase());
  if (!match) return null;
  const lastMessageAt = new Date(Number(match[1]));
  return Number.isNaN(lastMessageAt.getTime()) ? null : { lastMessageAt, id: match[2]! };
}

/** Sortierung der Liste: jüngste Aktivität zuerst, bei Gleichstand höhere ID zuerst. */
export function compareInboxRecency(a: InboxCursor, b: InboxCursor): number {
  const byTime = b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
