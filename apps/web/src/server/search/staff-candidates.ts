// =============================================================================
// Zweistufige Kanzleisuche (ACCESS-SEARCH-SCOPE-001, Review-Finding P-10).
//
// Unter RLS darf PostgreSQL `ILIKE` nicht als Indexbedingung nutzen (der
// Operator ist nicht LEAKPROOF und läuft erst nach den Policy-Bedingungen); die
// Suche läse jede Tenant-Zeile samt Policy-Funktionen. Stufe 1 holt deshalb
// Kandidaten-IDs über die Trigram-Indizes (`app.staff_search_candidates`,
// SECURITY DEFINER, Tenant ausschließlich aus dem Transaktionskontext, wie die
// Trefferliste sortiert). Stufe 2 lädt nur diese IDs unter RLS mit allen
// Zugriffsfiltern. Reichen die sichtbaren Treffer nicht (eingeschränkter
// Mandantenzugriff), folgt der nächste Kandidatenblock — begrenzt auf
// `SEARCH_CANDIDATE_ROUNDS` Runden.
// =============================================================================

import type { TxClient } from '@taxtronik/db';

export type SearchCandidateKind = 'client' | 'request' | 'document' | 'invoice';

/** Kandidaten je Block; Obergrenze der Datenbankfunktion. */
export const SEARCH_CANDIDATE_BATCH = 200;
/** Höchstens so viele Blöcke je Kategorie (bis 1.000 Kandidaten). */
export const SEARCH_CANDIDATE_ROUNDS = 5;

/** Ein Kandidatenblock aus Stufe 1 (nur IDs des eigenen Tenants). */
export async function searchCandidateIdsTx(
  tx: TxClient,
  kind: SearchCandidateKind,
  term: string,
  offset: number,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT candidate_id::text AS id
      FROM app.staff_search_candidates(${kind}, ${term}, ${SEARCH_CANDIDATE_BATCH}::int, ${offset}::int)
  `;
  return rows.map((row) => row.id);
}

/**
 * Sichtbare Treffer einer Kategorie in Trefferreihenfolge. `load` lädt die
 * übergebenen IDs unter RLS mit Zugriffs- und Suchfilter, sortiert wie die
 * Kandidaten und auf `take` begrenzt. Da jeder Block in der Gesamtordnung hinter
 * dem vorigen liegt, ergeben die angehängten Treffer dieselbe Reihenfolge wie
 * eine einstufige Abfrage.
 */
export async function visibleSearchHitsTx<T extends { id: string }>(
  tx: TxClient,
  kind: SearchCandidateKind,
  term: string,
  limit: number,
  load: (ids: string[], take: number) => Promise<T[]>,
): Promise<T[]> {
  const hits: T[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < SEARCH_CANDIDATE_ROUNDS && hits.length < limit; round++) {
    const ids = await searchCandidateIdsTx(tx, kind, term, round * SEARCH_CANDIDATE_BATCH);
    // Zwischen zwei Blöcken neu eingefügte Zeilen können eine ID verschieben.
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length > 0) {
      for (const hit of await load(fresh, limit - hits.length)) {
        if (hits.length < limit && !hits.some((known) => known.id === hit.id)) hits.push(hit);
      }
    }
    if (ids.length < SEARCH_CANDIDATE_BATCH) break;
  }
  return hits;
}
