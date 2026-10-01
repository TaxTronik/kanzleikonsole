import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Fachkatalog: ACCESS-SEARCH-SCOPE-001, ACCESS-TENANT-RLS-001.
// Real component and browser storage; only Next navigation and the naming
// dialog are replaced. This verifies account separation, not server RBAC.
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
const LEGACY_KEY = 'taxtronik:saved-views';
const ACCOUNT_KEY = `${LEGACY_KEY}:v2:["tenant-a","staff-a"]`;
let bundle: Promise<string> | undefined;

function savedViewsBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SavedViews} from './src/components/saved-views';
function Fixture(){
 const [scope,setScope]=useState({tenantId:'tenant-a',staffId:'staff-a'});
 globalThis.__update=patch=>setScope(previous=>({...previous,...patch}));
 return <main><SavedViews {...scope}/></main>;
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
        name: 'saved-view-ui-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^next\/navigation$/ }, () => ({
            path: 'navigation',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /^@\/components\/ui\/modal$/ }, () => ({
            path: 'dialog',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents:
              path === 'dialog'
                ? 'export const promptDialog=async()=>globalThis.__viewName;'
                : `export const usePathname=()=>globalThis.__pathname;
export const useSearchParams=()=>new URLSearchParams(globalThis.__query);
export const useRouter=()=>({push:path=>globalThis.__navigation=path});`,
            loader: 'ts',
            resolveDir: webRoot,
          }));
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

async function mount(page: Page, storage: Record<string, string> = {}) {
  const source = await savedViewsBundle();
  await page.addInitScript((values) => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    Object.assign(globalThis, {
      __pathname: '/staff/clients',
      __query: 'q=Vertrauliches+Mandat&status=active',
      __viewName: 'Mandat A intern',
    });
  }, storage);
  await page.route('http://saved-views.test/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('/fixture.js')
        ? { contentType: 'application/javascript', body: source }
        : {
            contentType: 'text/html',
            body: '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
          },
    ),
  );
  await page.goto('http://saved-views.test/');
  await expect(page.getByRole('button', { name: 'Aktuelle speichern' })).toBeVisible();
}

async function update(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((value) => {
    (globalThis as unknown as { __update: (patch: unknown) => void }).__update(value);
  }, patch);
}

test('discards legacy saved names/search queries instead of assigning them to the next user', async ({
  page,
}) => {
  await mount(page, {
    [LEGACY_KEY]: JSON.stringify({
      '/staff/clients': [{ name: 'Fremdes Mandat', query: 'q=secret' }],
    }),
  });
  await expect(page.getByRole('button', { name: 'Fremdes Mandat', exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), LEGACY_KEY)).toBe('{}');
});

test('separates saved names and search strings by staff and tenant, preserving the own account', async ({
  page,
}) => {
  await mount(page);
  await page.getByRole('button', { name: 'Aktuelle speichern' }).click();
  await expect(page.getByRole('button', { name: 'Mandat A intern', exact: true })).toBeVisible();
  await update(page, { staffId: 'staff-b' });
  await expect(page.getByRole('button', { name: 'Mandat A intern', exact: true })).toHaveCount(0);
  await update(page, { tenantId: 'tenant-b', staffId: 'staff-a' });
  await expect(page.getByRole('button', { name: 'Mandat A intern', exact: true })).toHaveCount(0);
  await update(page, { tenantId: 'tenant-a' });
  await page.getByRole('button', { name: 'Mandat A intern', exact: true }).click();
  expect(
    await page.evaluate(() => (globalThis as unknown as { __navigation: string }).__navigation),
  ).toBe('/staff/clients?q=Vertrauliches+Mandat&status=active');
  expect(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))).toEqual({
    [ACCOUNT_KEY]: JSON.stringify({
      '/staff/clients': [
        { name: 'Mandat A intern', query: 'q=Vertrauliches+Mandat&status=active' },
      ],
    }),
  });
  await page.getByRole('button', { name: 'Ansicht „Mandat A intern“ löschen' }).click();
  await expect(page.getByRole('button', { name: 'Mandat A intern', exact: true })).toHaveCount(0);
});

test('ignores malformed entries and duplicate names without crashing the list', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mount(page, {
    [ACCOUNT_KEY]: JSON.stringify({
      '/staff/clients': [
        null,
        {},
        { name: 12, query: 'x' },
        { name: 'Broken', query: null },
        { name: 'Valid', query: 'q=old' },
        { name: 'Valid', query: 'q=current' },
      ],
      '/staff/tax-deadlines': { name: 'Not an array', query: 'q=hidden' },
    }),
  });
  await expect(page.getByRole('button', { name: 'Valid', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Broken', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Valid', exact: true }).click();
  expect(
    await page.evaluate(() => (globalThis as unknown as { __navigation: string }).__navigation),
  ).toBe('/staff/clients?q=current');
  await page.evaluate(() => Object.assign(globalThis, { __pathname: '/staff/tax-deadlines' }));
  await update(page, {});
  await expect(page.getByRole('button', { name: 'Valid', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Aktuelle speichern' })).toBeVisible();
  expect(errors).toEqual([]);
});
