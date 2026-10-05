// Fachkatalog: ACCESS-SEARCH-SCOPE-001
import { describe, expect, it, vi } from 'vitest';
import {
  SEARCH_CANDIDATE_BATCH,
  SEARCH_CANDIDATE_ROUNDS,
  visibleSearchHitsTx,
} from '../staff-candidates';

/** Kandidaten-IDs `d0…d{n-1}` in Trefferreihenfolge, blockweise wie die Funktion. */
function txWithCandidates(total: number) {
  const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const [, , limit, offset] = values as [string, string, number, number];
    return Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
      id: `d${offset + i}`,
    }));
  });
  return { tx: { $queryRaw: queryRaw } as never, queryRaw };
}

/** Stufe 2: sichtbar sind nur IDs, die `visible` erfüllen; Reihenfolge bleibt. */
function loader(visible: (index: number) => boolean) {
  return vi.fn(async (ids: string[], take: number) =>
    ids
      .filter((id) => visible(Number(id.slice(1))))
      .slice(0, take)
      .map((id) => ({ id })),
  );
}

describe('visibleSearchHitsTx (zweistufige Suche)', () => {
  it('braucht bei ausreichend sichtbaren Kandidaten genau einen Block', async () => {
    const { tx, queryRaw } = txWithCandidates(1000);
    const load = loader(() => true);

    const hits = await visibleSearchHitsTx(tx, 'document', 'beleg', 5, load);

    expect(hits.map((h) => h.id)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0]!.slice(1)).toEqual([
      'document',
      'beleg',
      SEARCH_CANDIDATE_BATCH,
      0,
    ]);
    expect(load).toHaveBeenCalledWith(
      Array.from({ length: SEARCH_CANDIDATE_BATCH }, (_, i) => `d${i}`),
      5,
    );
  });

  it('holt bei eingeschränkter Sicht weitere Blöcke und behält die Reihenfolge', async () => {
    const { tx, queryRaw } = txWithCandidates(1000);
    // Nur jeder 150. Kandidat ist sichtbar (z. B. RESTRICTED).
    const load = loader((i) => i % 150 === 0);

    const hits = await visibleSearchHitsTx(tx, 'client', 'gmbh', 5, load);

    expect(hits.map((h) => h.id)).toEqual(['d0', 'd150', 'd300', 'd450', 'd600']);
    expect(queryRaw.mock.calls.map((call) => call[4])).toEqual([0, 200, 400, 600]);
    // Jeder weitere Block fragt nur noch die fehlenden Treffer ab.
    expect(load.mock.calls.map((call) => call[1])).toEqual([5, 3, 2, 1]);
  });

  it('endet, sobald ein Block nicht voll ist', async () => {
    const { tx, queryRaw } = txWithCandidates(SEARCH_CANDIDATE_BATCH + 10);
    const hits = await visibleSearchHitsTx(
      tx,
      'request',
      'x',
      5,
      loader(() => false),
    );
    expect(hits).toEqual([]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('ist auf eine feste Rundenzahl begrenzt', async () => {
    const { tx, queryRaw } = txWithCandidates(100_000);
    const load = loader(() => false);
    await expect(visibleSearchHitsTx(tx, 'document', 'x', 5, load)).resolves.toEqual([]);
    expect(queryRaw).toHaveBeenCalledTimes(SEARCH_CANDIDATE_ROUNDS);
  });

  it('lädt ohne Kandidaten nichts und dedupliziert verschobene IDs', async () => {
    const empty = txWithCandidates(0);
    const load = loader(() => true);
    await expect(visibleSearchHitsTx(empty.tx, 'invoice', 'x', 5, load)).resolves.toEqual([]);
    expect(load).not.toHaveBeenCalled();

    // Eine zwischen zwei Blöcken eingefügte Zeile verschiebt `d199` in Block 2.
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: SEARCH_CANDIDATE_BATCH }, (_, i) => ({ id: `d${i}` })),
      )
      .mockResolvedValueOnce([{ id: 'd199' }, { id: 'd200' }]);
    const sparse = loader((i) => i === 199 || i === 200);
    const hits = await visibleSearchHitsTx(
      { $queryRaw: queryRaw } as never,
      'document',
      'x',
      5,
      sparse,
    );
    expect(hits.map((h) => h.id)).toEqual(['d199', 'd200']);
    expect(sparse.mock.calls[1]![0]).toEqual(['d200']);
  });
});
