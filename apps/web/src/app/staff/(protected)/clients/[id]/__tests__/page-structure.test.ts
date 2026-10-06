import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const routeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRouteFile = (name: string) => readFileSync(resolve(routeDir, name), 'utf8');

describe('Mandanten-Cockpit Datenaufteilung', () => {
  it('hält DB-Orchestrierung aus page.tsx heraus und streamt Dokumente separat', () => {
    const page = readRouteFile('page.tsx');

    expect(page).toContain('loadClientCockpitHeader(settingsCtx, session, id)');
    expect(page).toContain('loadClientCockpitBlocks(settingsCtx, session, id, modules, now)');
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
    expect(data).toContain('deletedAt: query.deleted ? { not: null } : null');
    expect(block).toContain('von ${data.totalCount.toLocaleString');
    expect(block).toContain(
      'clientDocumentsPageHref(client.id, { ...current, page: data.page + 1 })',
    );
    expect(block).toContain('deletedHref: hrefFor({ deleted: true })');
    // Ordner und Suche filtern serverseitig über alle Dokumente (URL-Parameter).
    expect(block).toContain('loadClientDocumentsPage(ctx, session, client.id, query)');
    expect(block).toContain('serverFilter={{');
    expect(block).not.toContain('filtern die aktuell angezeigte Seite');
    expect(block).toContain('← Zurück');
    expect(block).toContain('Weiter →');
  });

  it('streamt Kopf vor den Blöcken und lässt den Engine-Healthcheck nur die Pill aufhalten (P-07)', () => {
    const page = readRouteFile('page.tsx');
    const blocks = readRouteFile('cockpit-blocks.tsx');

    // Blockdaten starten vor dem Warten auf den Kopf und werden nicht abgewartet.
    expect(page.indexOf('loadClientCockpitBlocks(')).toBeLessThan(
      page.indexOf('loadClientCockpitHeader('),
    );
    expect(page).not.toMatch(/await\s+loadClientCockpitBlocks/);
    for (const block of [
      'UpcomingCockpitBlock',
      'WorkflowsCockpitBlock',
      'RemindersCockpitBlock',
      'BindersCockpitBlock',
      'HandoversCockpitBlock',
      'PhoneNotesCockpitBlock',
      'RequestsCockpitBlock',
    ]) {
      expect(page).toMatch(
        new RegExp(`<Suspense fallback=\\{<CockpitBlockSkeleton[^}]*\\}>\\s*<${block}`),
      );
      expect(blocks).toContain(`export async function ${block}(`);
    }
    expect(blocks).toContain('const data = await blocks;');
    expect(page.match(/isRiskLayerAvailable\(\)/g)).toHaveLength(1);
    expect(page).toContain('<SubsumtionNavLink clientId={client.id} />');
  });

  it('hat Ladezustände auf (protected)-Ebene (P-07)', () => {
    const appDir = resolve(routeDir, '../../../..');
    for (const file of ['staff/(protected)/loading.tsx', 'portal/(protected)/loading.tsx']) {
      const source = readFileSync(resolve(appDir, file), 'utf8');
      expect(source).toMatch(/export default function \w+Loading\(\)/);
    }
  });
});
