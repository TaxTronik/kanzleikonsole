import { describe, expect, it } from 'vitest';
import { inboxMetadataSearch } from '../search';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001 (Entwurf).

describe('Portal-Inbox-Suchscope', () => {
  it('verwendet im Portal nur Betreff und freigegebenen Mandantennamen', () => {
    expect(inboxMetadataSearch('4711', 'portal')).toEqual([
      { subject: { contains: '4711', mode: 'insensitive' } },
      { client: { name: { contains: '4711', mode: 'insensitive' } } },
    ]);
  });

  it('erlaubt interne Kanzleikennungen ausschließlich in der Staff-Suche', () => {
    const serialized = JSON.stringify(inboxMetadataSearch('4711', 'staff'));
    expect(serialized).toContain('datevNo');
    expect(serialized).toContain('addisonNo');
  });
});
