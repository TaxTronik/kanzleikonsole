// =============================================================================
// Hinweis bei begrenzter Trefferliste (Review-Finding P-10, Welle 15): Die
// Suchen im Posteingang laden nur die jüngsten Treffer bis zu einer Grenze.
// Ältere Treffer dürfen nicht stillschweigend fehlen.
// =============================================================================

export function SearchLimitHint({ paging }: { paging?: { truncated: boolean; limit: number } }) {
  if (!paging?.truncated) return null;
  const limit = paging.limit.toLocaleString('de-DE');
  return (
    <p role="status" className="alert-warning m-4">
      Mehr als {limit} Treffer – Suche verfeinern. Angezeigt werden die {limit} zuletzt aktiven
      Verläufe.
    </p>
  );
}
