// Fachkatalog: MAIL-INBOX-001
import { describe, it, expect } from 'vitest';
import { suggestInboundClients } from '../suggestions';
const clients = [
  { id: 'one', name: 'One', contacts: [{ email: 'client@example.test' }] },
  { id: 'two', name: 'Two', contacts: [{ email: 'alias@example.test' }] },
];
describe('untrusted mailbox suggestions', () => {
  it('recognizes exact sender and recipient addresses without selecting a mandate', () => {
    expect(
      suggestInboundClients('Client <CLIENT@example.test>', 'alias@example.test', clients),
    ).toEqual([
      { id: 'one', name: 'One' },
      { id: 'two', name: 'Two' },
    ]);
  });
  it('never suggests an inaccessible client absent from the scoped input', () => {
    expect(
      suggestInboundClients('client@example.test', 'alias@example.test', clients.slice(1)),
    ).toEqual([{ id: 'two', name: 'Two' }]);
  });
  it('does not accept display names or partial domain matches as addresses', () => {
    expect(suggestInboundClients('client@example.test.evil', 'Client', clients)).toEqual([]);
  });
});
