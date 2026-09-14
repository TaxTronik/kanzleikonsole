import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// KNOWLEDGE-CONTEXT-001: tatsächlicher Editor, nur Speicherung ist simuliert.
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
let bundle: Promise<string> | undefined;

async function mountEditor(page: Page) {
  bundle ??= build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';
import {ContextEditor} from './src/app/staff/(protected)/knowledge/context/editor';
globalThis.__calls=[];globalThis.__save=input=>{globalThis.__calls.push(input);return new Promise((resolve,reject)=>{globalThis.__resolve=resolve;globalThis.__reject=reject});};
createRoot(document.getElementById('root')).render(<ContextEditor targets={[{id:'a',type:'STEP',label:'Vorlage A',articleIds:[]},{id:'b',type:'TEMPLATE',label:'Vorlage B',articleIds:['article-12']}]} articles={Array.from({length:12},(_,i)=>({id:'article-'+(i+1),title:'Artikel '+(i+1)}))}/>);`,
      loader: 'tsx',
      resolveDir: dirname(webRequire.resolve('./package.json')),
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [
      {
        name: 'knowledge-context-action',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/actions$/ }, () => ({
            path: 'actions',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const saveKnowledgeContextAction=input=>globalThis.__save(input);',
            loader: 'ts',
          }));
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  await page.route('https://knowledge-context.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html lang="de"><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto('https://knowledge-context.test/');
  await page.addScriptTag({ content: await bundle });
}

test('erklärt die Zehnergrenze und erlaubt Abwählen statt einer elften Auswahl', async ({
  page,
}) => {
  await mountEditor(page);
  await page.getByRole('combobox').selectOption('STEP:a');
  for (let i = 1; i <= 10; i++)
    await page.getByRole('checkbox', { name: 'Artikel ' + i, exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Artikel 11', exact: true })).toBeDisabled();
  await expect(page.getByText('10 von höchstens 10 Artikeln ausgewählt.')).toBeVisible();
  await expect(
    page.getByText('Wählen Sie einen Artikel ab, um einen anderen hinzuzufügen.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Artikel 3', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'Artikel 11', exact: true }).check();
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  expect(await page.evaluate('globalThis.__calls[0].articleIds')).toHaveLength(10);
  await page.evaluate('globalThis.__resolve({ok:true})');
});

test('behält Entwürfe beim Zielwechsel und zeigt nach Speichern beim Zurückwechseln den gespeicherten Stand', async ({
  page,
}) => {
  await mountEditor(page);
  const target = page.getByRole('combobox');
  await target.selectOption('STEP:a');
  await page.getByRole('checkbox', { name: 'Artikel 1', exact: true }).check();
  await target.selectOption('TEMPLATE:b');
  await expect(page.getByRole('checkbox', { name: 'Artikel 12', exact: true })).toBeChecked();
  await target.selectOption('STEP:a');
  await expect(page.getByRole('checkbox', { name: 'Artikel 1', exact: true })).toBeChecked();
  await expect(page.getByText('Nicht gespeicherte Änderungen.')).toBeVisible();
  expect(await page.evaluate('globalThis.__calls')).toEqual([]);
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(target).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Artikel 1', exact: true })).toBeDisabled();
  expect(await page.evaluate('globalThis.__calls')).toEqual([
    { type: 'STEP', id: 'a', articleIds: ['article-1'] },
  ]);
  await page.evaluate('globalThis.__resolve({ok:true})');
  await expect(
    page.getByText('Verknüpfung gespeichert. Laufende Vorgänge bleiben unverändert.'),
  ).toBeVisible();
  await target.selectOption('TEMPLATE:b');
  await expect(
    page.getByText('Verknüpfung gespeichert. Laufende Vorgänge bleiben unverändert.'),
  ).toHaveCount(0);
  await target.selectOption('STEP:a');
  await expect(page.getByRole('checkbox', { name: 'Artikel 1', exact: true })).toBeChecked();
  await expect(page.getByText('Nicht gespeicherte Änderungen.')).toHaveCount(0);
});

test('behält nach geworfenem Speicherfehler den Entwurf und ermöglicht erneutes Speichern', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mountEditor(page);
  await page.getByRole('combobox').selectOption('STEP:a');
  await page.getByRole('checkbox', { name: 'Artikel 1', exact: true }).check();
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await page.evaluate('globalThis.__reject(new Error("Netzwerkfehler"))');
  await expect(page.getByText('Speichern fehlgeschlagen. Bitte erneut versuchen.')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Artikel 1', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
