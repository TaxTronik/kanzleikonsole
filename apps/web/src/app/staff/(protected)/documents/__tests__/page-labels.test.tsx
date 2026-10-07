// =============================================================================
// R-14: Die Dokumentablage (/staff/documents) benennt ihre Einstiegsebenen aus
// der gemeinsamen Label-Quelle (lib/domain-labels.ts, DOCUMENT_SCOPE_LABELS)
// statt aus einer eigenen KIND_LABEL-Tabelle. Die sichtbaren Texte bleiben.
// =============================================================================

import { isValidElement, type ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Crumb, Entry } from '@/components/document-explorer';

const h = vi.hoisted(() => ({
  tx: {
    client: { findMany: vi.fn(), findFirst: vi.fn() },
    documentFolder: { findMany: vi.fn() },
    document: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: async () => ({ user: { tenantId: 'tenant-1', staffId: 'staff-1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({
  accessibleClientsWhereFor: async () => ({}),
  canAccessClientTx: async () => true,
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) => run(h.tx),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/components/document-explorer', () => ({ DocumentExplorer: () => null }));

import DocumentsPage from '../page';
import { DOCUMENT_SCOPE_LABELS } from '@/lib/domain-labels';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

async function explorerProps(search: Record<string, string>) {
  const element = (await DocumentsPage({ searchParams: Promise.resolve(search) })) as ReactElement<{
    entries: Entry[];
    crumbs: Crumb[];
  }>;
  expect(isValidElement(element)).toBe(true);
  return element.props;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.client.findMany.mockResolvedValue([{ id: CLIENT_ID, name: 'Muster GmbH' }]);
  h.tx.client.findFirst.mockResolvedValue({ name: 'Muster GmbH', kind: 'JURPERS' });
  h.tx.documentFolder.findMany.mockResolvedValue([]);
  h.tx.document.findMany.mockResolvedValue([]);
});

describe('Dokumentablage: Einstiegsebenen aus der gemeinsamen Label-Quelle (R-14)', () => {
  it('benennt Mandantentypen und Kanzlei-intern auf der Startebene', async () => {
    const { entries } = await explorerProps({});

    expect(entries.map((entry) => ('name' in entry ? entry.name : null))).toEqual([
      'Natürliche Personen',
      'Juristische Personen',
      'Personengesellschaften',
      'Kanzlei-intern',
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(Object.keys(DOCUMENT_SCOPE_LABELS));
  });

  it('nennt den Mandantentyp im Pfad der Typ- und der Mandantenebene', async () => {
    const typeLevel = await explorerProps({ type: 'JURPERS' });
    expect(typeLevel.crumbs.map((crumb) => crumb.label)).toEqual([
      'Dokumente',
      'Juristische Personen',
    ]);

    const clientLevel = await explorerProps({ type: 'JURPERS', client: CLIENT_ID });
    expect(clientLevel.crumbs.map((crumb) => crumb.label)).toEqual([
      'Dokumente',
      'Juristische Personen',
      'Muster GmbH',
    ]);
  });

  it('nennt die kanzleiinterne Ablage im Pfad', async () => {
    const { crumbs } = await explorerProps({ type: 'INTERNAL' });

    expect(crumbs.map((crumb) => crumb.label)).toEqual(['Dokumente', 'Kanzlei-intern']);
  });
});
