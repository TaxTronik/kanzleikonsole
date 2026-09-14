import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001, ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001
// Echte Komponenten und Browser-Storage; die bereits autorisierte Serverliste
// wird als Prop geliefert. Dieser Test ersetzt keine DB-/RBAC-Prüfung.
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
const LEGACY_KEY = 'taxtronik:recent-clients';
const ACCOUNT_KEY = `${LEGACY_KEY}:v2:["tenant-a","staff-a"]`;
let bundle: Promise<string> | undefined;

function recentClientsBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RecentClients,RecordClientVisit} from './src/components/recent-clients';
function Fixture(){
 const [props,setProps]=useState(globalThis.__initial);
 globalThis.__update=patch=>setProps(previous=>({...previous,...patch}));
 return <main aria-label="Zuletzt besuchte Mandanten">
  {props.visit&&<RecordClientVisit tenantId={props.tenantId} staffId={props.staffId} id={props.visit}/>}
  <RecentClients {...props}/>
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
      loader: 'tsx',
      resolveDir: webRoot,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [
      {
        name: 'next-link-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^next\/link$/ }, () => ({
            path: 'link',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              "import React from 'react';export default function Link(props){return <a {...props}/>;}",
            loader: 'tsx',
            resolveDir: webRoot,
          }));
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

async function mountRecentClients(
  page: Page,
  overrides: Record<string, unknown> = {},
  storage: Record<string, string> = {},
) {
  const source = await recentClientsBundle();
  await page.addInitScript(
    ({ props, values }) => {
      for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
      Object.assign(globalThis, { __initial: props });
    },
    {
      props: {
        tenantId: 'tenant-a',
        staffId: 'staff-a',
        clients: [{ id: 'client-a', name: 'Aktueller Mandant' }],
        visit: null,
        ...overrides,
      },
      values: storage,
    },
  );
  await page.route('http://recent-clients.test/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('/fixture.js')
        ? { contentType: 'application/javascript', body: source }
        : {
            contentType: 'text/html',
            body: '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
          },
    ),
  );
  await page.goto('http://recent-clients.test/');
  await expect(page.getByRole('main')).toBeAttached();
}

async function update(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((value) => {
    (globalThis as unknown as { __update: (patch: unknown) => void }).__update(value);
  }, patch);
}

for (const hasVisibleClient of [false, true]) {
  test(`verwirft kontofremde Altnamen auch bei gleicher ID (sichtbare Liste: ${hasVisibleClient})`, async ({
    page,
  }) => {
    await mountRecentClients(
      page,
      { clients: hasVisibleClient ? [{ id: 'client-a', name: 'Aktueller Mandant' }] : [] },
      { [LEGACY_KEY]: JSON.stringify([{ id: 'client-a', name: 'Fremder Altbestand' }]) },
    );
    await expect(page.getByRole('link')).toHaveCount(0);
    await expect(page.getByText('Zuletzt:')).toHaveCount(0);
    await expect(page.getByText('Fremder Altbestand')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY))
      .toBe('[]');
  });
}

test('speichert nur IDs und übernimmt eine Umbenennung aus der aktuellen Serverliste', async ({
  page,
}) => {
  await mountRecentClients(page, { visit: 'client-a' });
  await expect(page.getByRole('link', { name: 'Aktueller Mandant' })).toHaveAttribute(
    'href',
    '/staff/clients/client-a',
  );
  await update(page, { clients: [{ id: 'client-a', name: 'Umbenannter Mandant' }] });
  await expect(page.getByRole('link', { name: 'Umbenannter Mandant' })).toBeVisible();
  await expect(page.getByText('Aktueller Mandant')).toHaveCount(0);
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual({
    [ACCOUNT_KEY]: '["client-a"]',
  });
});

test('trennt Mitarbeiter und Kanzleien auch bei identischen Mandanten-IDs', async ({ page }) => {
  await mountRecentClients(page, { visit: 'client-a' });
  await expect(page.getByRole('link')).toHaveCount(1);
  await update(page, { staffId: 'staff-b', visit: null });
  await expect(page.getByRole('link')).toHaveCount(0);
  await update(page, { tenantId: 'tenant-b', staffId: 'staff-a' });
  await expect(page.getByRole('link')).toHaveCount(0);
  await update(page, { tenantId: 'tenant-a' });
  await expect(page.getByRole('link', { name: 'Aktueller Mandant' })).toBeVisible();
});

test('zeigt nur aktuell gelieferte Mandanten und bewahrt IDs über Filter-/Seitenwechsel', async ({
  page,
}) => {
  const ids = '["denied","deleted","client-a"]';
  await mountRecentClients(page, {}, { [ACCOUNT_KEY]: ids });
  await expect(page.getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Aktueller Mandant' })).toBeVisible();
  await update(page, { clients: [] });
  await expect(page.getByRole('link')).toHaveCount(0);
  await expect(page.getByText('Zuletzt:')).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), ACCOUNT_KEY)).toBe(ids);
  await update(page, { clients: [{ id: 'client-a', name: 'Aktueller Mandant' }] });
  await expect(page.getByRole('link')).toHaveCount(1);
  await update(page, { excludeId: 'client-a' });
  await expect(page.getByRole('link')).toHaveCount(0);
});

test('ignoriert beschädigte Einträge und doppelte IDs bei begrenzter Besuchshistorie', async ({
  page,
}) => {
  const clients = Array.from({ length: 10 }, (_, index) => ({
    id: `client-${index}`,
    name: `Mandant ${index}`,
  }));
  await mountRecentClients(
    page,
    { clients },
    {
      [ACCOUNT_KEY]: JSON.stringify([
        null,
        {},
        '',
        { id: 'client-9', name: 'Veralteter Name' },
        'client-0',
        ...clients.map(({ id }) => id),
      ]),
    },
  );
  await expect(page.getByRole('link')).toHaveCount(8);
  await expect(page.getByRole('link', { name: 'Mandant 0', exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Mandant 8', exact: true })).toHaveCount(0);
  await expect(page.getByText('Veralteter Name')).toHaveCount(0);
  await update(page, { visit: 'client-9' });
  await expect(page.getByRole('link').first()).toHaveText('Mandant 9');
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), ACCOUNT_KEY)).toEqual(
    [
      'client-9',
      'client-0',
      'client-1',
      'client-2',
      'client-3',
      'client-4',
      'client-5',
      'client-6',
    ],
  );
});
