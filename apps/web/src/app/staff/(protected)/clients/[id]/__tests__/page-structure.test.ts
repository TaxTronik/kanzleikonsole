import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRouteFile = (name: string) => readFileSync(resolve(routeDir, name), 'utf8');

describe('Mandanten-Cockpit Datenaufteilung', () => {
  it('hält DB-Orchestrierung aus page.tsx heraus und streamt Dokumente separat', () => {
    const page = readRouteFile('page.tsx');

    expect(page).toContain('loadClientDashboard(settingsCtx, session, id)');
    expect(page).not.toContain('withTenantContext');
    expect(page).not.toContain('tx.document');
    expect(page).toMatch(
      /<Suspense[\s\S]*fallback=\{<ClientDocumentsSkeleton \/>\}[\s\S]*<ClientDocumentsBlock/,
    );
  });

  it('bietet für den 50er-Dokument-Payload Gesamtzahl und Vor-/Weiter-Navigation', () => {
    const data = readRouteFile('_data.ts');
    const block = readRouteFile('client-documents-block.tsx');

    expect(data).toContain('export const CLIENT_DOCUMENTS_PAGE_SIZE = 50');
    expect(data).toContain('totalCount');
    expect(data).toContain('take: CLIENT_DOCUMENTS_PAGE_SIZE');
    expect(data).toContain('deletedAt: deleted ? { not: null } : null');
    expect(block).toContain('von ${data.totalCount.toLocaleString');
    expect(block).toContain('clientDocumentsPageHref(client.id, data.page + 1, data.deleted)');
    expect(block).toContain('deletedHref: clientDocumentsPageHref(client.id, 1, true)');
    expect(block).toContain('← Zurück');
    expect(block).toContain('Weiter →');
  });
});
