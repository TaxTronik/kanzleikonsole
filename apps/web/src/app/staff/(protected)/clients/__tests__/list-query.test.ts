import { describe, expect, it } from 'vitest';
import {
  CLIENT_KIND_OPTIONS,
  clientOrderBy,
  parseClientKind,
  parseClientSort,
} from '../list-query';

describe('Mandantenlisten-Query', () => {
  it.each(CLIENT_KIND_OPTIONS)('akzeptiert den Mandantentyp $value', ({ value }) => {
    expect(parseClientKind(value)).toBe(value);
  });

  it.each([undefined, '', 'INTERNAL', 'jurpers'])('ignoriert ungültigen Typ %s', (value) => {
    expect(parseClientKind(value)).toBeUndefined();
  });

  it('parst die Typ-Sortierung mit Richtung', () => {
    expect(parseClientSort({ sort: 'kind', dir: 'desc' })).toEqual({
      sort: 'kind',
      dir: 'desc',
    });
  });

  it('fällt bei ungültiger Sortierung sicher auf Name aufsteigend zurück', () => {
    expect(parseClientSort({ sort: 'unbekannt', dir: 'seitwaerts' })).toEqual({
      sort: 'name',
      dir: 'asc',
    });
  });

  it('sortiert Typgruppen stabil nach Mandantenname', () => {
    expect(clientOrderBy('kind', 'asc')).toEqual([{ kind: 'asc' }, { name: 'asc' }]);
  });
});
