// Fachkatalog: ACCESS-CLIENT-MODE-001
// Reine Form der Relationsfilter; die Gleichwertigkeit der sichtbaren Zeilen
// gegenüber der früheren NOT-IN-Liste belegt client-access-filter-db.test.ts.
import { describe, expect, it } from 'vitest';
import { clientAccessFilter, optionalClientAccessFilter } from '../client-access-filter';

const restricted = {
  responsibilities: {
    some: { staffId: 's1', role: { in: ['BERUFSTRAEGER' as const, 'HAUPTBEARBEITER' as const] } },
  },
};
const open = { OR: [{ vertraulich: false }, restricted] };

describe('clientAccessFilter (Pflicht-Mandant)', () => {
  it('setzt für Admin/Partner (Regel `{}`) oder fehlende Regel keine Bedingung', () => {
    expect(clientAccessFilter({})).toEqual({});
    expect(clientAccessFilter(undefined)).toEqual({});
  });

  it('filtert über die Relation statt über eine ID-Liste', () => {
    expect(clientAccessFilter(open)).toEqual({ client: open });
    expect(clientAccessFilter(restricted)).toEqual({ client: restricted });
  });

  it('verbindet weitere Mandantenbedingungen im selben Schlüssel per AND', () => {
    const mine = { responsibilities: { some: { staffId: 's1' } } };
    expect(clientAccessFilter(open, mine)).toEqual({ client: { AND: [open, mine] } });
    // Admin/Partner: nur die Seitenbedingung, leere Teile entfallen.
    expect(clientAccessFilter({}, mine, {}, undefined)).toEqual({ client: mine });
  });
});

describe('optionalClientAccessFilter (nullable clientId)', () => {
  it('behält Datensätze ohne Mandantenbezug', () => {
    expect(optionalClientAccessFilter(restricted)).toEqual({
      OR: [{ clientId: null }, { client: restricted }],
    });
  });

  it('setzt für Admin/Partner keine Bedingung', () => {
    expect(optionalClientAccessFilter({})).toEqual({});
    expect(optionalClientAccessFilter(undefined)).toEqual({});
  });
});
