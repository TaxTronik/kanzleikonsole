import { describe, expect, it } from 'vitest';
import { extractTicketNumbers, splitByTicketReferences } from '../reminder-ticket-references';

// Fachkatalog: REMINDER-TICKET-001
describe('Ticket-Erwähnungen', () => {
  it('erkennt eigenständige Nummern und entdoppelt in Erwähnungsreihenfolge', () => {
    expect(extractTicketNumbers('Siehe #42, (#7), [#123] und erneut #42.\n#5!')).toEqual([
      42, 7, 123, 5,
    ]);
  });

  it.each([
    '#0 #01 #000123',
    'https://example.test/#123 https://example.test/a#456',
    'wort#123 über#234 中文#345 #12abc #345ä #123_test ##55',
    '#1.5 #1,50 #1/2',
    '#2147483648 #9999999999999999999999999999999',
    'ticket="123" &id=#321',
  ])('verwechselt andere Schreibweisen nicht mit Verweisen: %s', (text) => {
    expect(extractTicketNumbers(text)).toEqual([]);
  });

  it('unterstützt die gesamte positive PostgreSQL-Int-Spanne', () => {
    expect(extractTicketNumbers('#1 und #2147483647')).toEqual([1, 2_147_483_647]);
  });

  it('erhält den vollständigen Text einschließlich nicht erkannter Nummern', () => {
    const text = 'Prüfen: #2147483648, #4\n#4 und <script>#8</script> 🗂️ #02.';
    const segments = splitByTicketReferences(text);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(segments.filter((segment) => segment.ticketNumber !== null)).toEqual([
      { text: '#4', ticketNumber: 4 },
      { text: '#4', ticketNumber: 4 },
      { text: '#8', ticketNumber: 8 },
    ]);
  });

  it('liefert für leeren Text ein unverändertes Textsegment', () => {
    expect(splitByTicketReferences('')).toEqual([{ text: '', ticketNumber: null }]);
  });
});
