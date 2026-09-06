import type { Prisma } from '@prisma/client';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001 (Entwurf). Portal-Kontakte dürfen
// interne Kanzleikennungen nicht über Treffer/Kein-Treffer auslesen.
export function inboxMetadataSearch(
  query: string,
  surface: 'portal' | 'staff',
): Prisma.PortalInboxThreadWhereInput[] {
  if (!query) return [];
  const shared: Prisma.PortalInboxThreadWhereInput[] = [
    { subject: { contains: query, mode: 'insensitive' } },
    { client: { name: { contains: query, mode: 'insensitive' } } },
  ];
  if (surface === 'portal') return shared;
  return [
    ...shared,
    { client: { datevNo: { contains: query, mode: 'insensitive' } } },
    { client: { addisonNo: { contains: query, mode: 'insensitive' } } },
  ];
}
