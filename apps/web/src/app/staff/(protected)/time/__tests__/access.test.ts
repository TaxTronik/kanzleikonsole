import { describe, expect, it } from 'vitest';
import { buildTimePageClientQueries, withoutHiddenClients } from '../access';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const restricted = {
  responsibilities: {
    some: { staffId: 's1', role: { in: ['BERUFSTRAEGER' as const, 'HAUPTBEARBEITER' as const] } },
  },
};

describe('Zeiterfassungsseite — RESTRICTED-Filter', () => {
  it('prüft nur die referenzierten Mandanten gegen die Sichtbarkeitsregel', () => {
    expect(buildTimePageClientQueries(ids, restricted)).toEqual({
      visibleWhere: { AND: [{ id: { in: ids } }, restricted] },
      hiddenWhere: { id: { in: ids }, NOT: restricted },
    });
  });

  it('sperrt für Admin/Partner (Regel `{}`) nichts', () => {
    expect(buildTimePageClientQueries(ids, {})).toEqual({
      visibleWhere: { AND: [{ id: { in: ids } }, {}] },
      hiddenWhere: null,
    });
  });

  it('blendet Einträge gesperrter Mandanten aus und behält interne Zeiten', () => {
    const entries = [
      { id: 'a', clientId: ids[0]! },
      { id: 'b', clientId: ids[1]! },
      { id: 'c', clientId: null },
    ];
    expect(withoutHiddenClients(entries, new Set([ids[1]!])).map((e) => e.id)).toEqual(['a', 'c']);
    expect(withoutHiddenClients(entries, new Set()).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});
