import { describe, expect, it } from 'vitest';
import { buildTimePageAccessFilters } from '../access';

describe('Zeiterfassungsseite — RESTRICTED-Filter', () => {
  it('filtert gesperrte Mandanten aus Auswahl und Zeiteinträgen', () => {
    const denied = ['11111111-1111-4111-8111-111111111111'];
    expect(buildTimePageAccessFilters(denied)).toEqual({
      timeEntryWhere: {
        OR: [{ clientId: null }, { clientId: { notIn: denied } }],
      },
      clientWhere: { id: { notIn: denied } },
    });
  });

  it('erzeugt ohne gesperrte Mandanten keine Zusatzfilter', () => {
    expect(buildTimePageAccessFilters([])).toEqual({
      timeEntryWhere: {},
      clientWhere: undefined,
    });
  });
});
