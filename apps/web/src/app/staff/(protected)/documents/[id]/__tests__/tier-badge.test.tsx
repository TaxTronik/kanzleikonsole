// Fachkatalog: GWG-RETENTION-DESTRUCTION-001
//
// R-14: Die Detailseite leitet die Schutzstufe wie Explorer und Storage ab.
// Vorher markierte sie GwG-Nachweise als „GoBD-immutable“ (COMPLIANCE-Lock).
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ doc: null as Record<string, unknown> | null }));

vi.mock('@/server/auth/staff-page', () => ({
  requireStaffPage: async () => ({ user: { tenantId: 't1', staffId: 's1' } }),
}));
vi.mock('@/server/auth/rbac', () => ({ canAccessClientTx: async () => true }));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: async (_ctx: unknown, run: (tx: unknown) => unknown) =>
    run({
      document: { findUnique: async () => h.doc },
      staffUser: { findUnique: async () => null },
    }),
}));
vi.mock('@/components/document-preview', () => ({ DocumentPreviewButton: () => null }));
vi.mock('../../acknowledge-button', () => ({ AcknowledgeButton: () => null }));
vi.mock('../new-version-form', () => ({ NewVersionForm: () => null }));

import DocumentDetailPage from '../page';

function documentRow(classification: string, typeTier: string | null) {
  return {
    id: 'd1',
    title: 'Beleg',
    classification,
    documentType: typeTier ? { tier: typeTier } : null,
    client: null,
    acknowledgedByStaff: null,
    acknowledgedAt: null,
    retentionUntil: null,
    versions: [
      {
        id: 'v1',
        versionNo: 1,
        createdAt: new Date('2026-01-02T10:00:00.000Z'),
        sizeBytes: 10n,
        sha256: new Uint8Array(32),
        scanStatus: 'CLEAN',
      },
    ],
  };
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await DocumentDetailPage({ params: Promise.resolve({ id: 'd1' }) }));
}

describe('Dokument-Detailseite: Schutzstufen-Badge', () => {
  beforeEach(() => {
    h.doc = null;
  });

  it('kennzeichnet GoBD-Belege weiterhin als GoBD-immutable (COMPLIANCE)', async () => {
    h.doc = documentRow('GOBD_INVOICE', null);
    const html = await renderPage();
    expect(html).toContain('GoBD-immutable');
    expect(html).toContain('Object-Lock COMPLIANCE');
  });

  it('kennzeichnet GwG-Nachweise nicht als GoBD', async () => {
    h.doc = documentRow('GWG_EVIDENCE', null);
    const html = await renderPage();
    expect(html).not.toContain('GoBD-immutable');
    expect(html).not.toContain('COMPLIANCE');
    expect(html).toContain('GwG·5J+Prüfung');
  });

  it('folgt der Stufe des Dokumenttyps', async () => {
    h.doc = documentRow('GENERAL', 'GOBD');
    expect(await renderPage()).toContain('GoBD-immutable');
    h.doc = documentRow('GENERAL', 'NONE');
    const html = await renderPage();
    expect(html).not.toContain('GoBD-immutable');
    expect(html).not.toContain('GwG·5J+Prüfung');
  });
});
