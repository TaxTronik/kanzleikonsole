// Fachkatalog: ACCESS-SEARCH-SCOPE-001, REQ-LIFECYCLE-001,
// DOC-PORTAL-SHARING-001, INV-PORTAL-SHARING-001

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function pageSource(name: 'requests' | 'documents' | 'invoices'): string {
  return readFileSync(new URL(`../${name}/page.tsx`, import.meta.url), 'utf8');
}

describe('Portal-Listen UX und Zugriffsscope', () => {
  it.each(['requests', 'documents', 'invoices'] as const)(
    '%s nutzt serverseitige 25er-URL-Pagination und mobile Karten',
    (name) => {
      const source = pageSource(name);
      expect(source).toContain('PORTAL_LIST_PAGE_SIZE');
      expect(source).toContain('<OffsetPagination');
      expect(source).toContain(`action="/portal/${name}"`);
      expect(source).toMatch(name === 'requests' ? /<ul className="divide-/ : /md:hidden/);
      expect(source).not.toContain('take: 100');
    },
  );

  it('schließt persönliche Anforderungen mit demselben Helper wie die Detailöffnung aus', () => {
    // Fachkatalog REQ-LIFECYCLE-001: kein Titel-/Treffermengen-Leak aus dem
    // persönlichen Interaktionskanal in die mandantenweite Anforderungsliste.
    const source = pageSource('requests');
    expect(source).toContain('NOT app.interaction_request(r.id)');
    expect(source).toContain('strpos(lower(r.title)');
  });

  it('bindet Dokument- und Rechnungsfilter an ihre vollständigen Portalregeln', () => {
    // Fachkatalog DOC-PORTAL-SHARING-001 und INV-PORTAL-SHARING-001.
    const documents = pageSource('documents');
    expect(documents).toContain('sharedWithClientAt: { not: null }');
    expect(documents).toContain('deletedAt: null');
    expect(documents).toContain('requiresPayrollAccess: false');

    const invoices = pageSource('invoices');
    expect(invoices).toContain('portalInvoiceVisibilityWhere(clientId)');
    expect(invoices).not.toContain("status: { not: 'DRAFT' }");
  });
});
