import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';

// PORTAL-INBOX-SUBMISSION-001: Lesestand folgt der tatsächlich angezeigten Nachrichtenversion.
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');

test('sendet beim Aktualisieren desselben Threads nur für einen neuen Nachrichtenstand eine Lesequittung', async ({
  page,
}) => {
  const result = await build({
    stdin: {
      contents: `import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {MarkInboxThreadRead} from './src/app/portal/(protected)/inbox/mark-read';
globalThis.__reads=[];globalThis.__pendingReads=[];globalThis.__renderedRevision=0;
globalThis.__read=form=>{globalThis.__reads.push(Object.fromEntries(form));return new Promise(resolve=>globalThis.__pendingReads.push(resolve));};
function Fixture({lastMessageAt,revision}){useEffect(()=>{globalThis.__renderedRevision=revision},[revision]);return <MarkInboxThreadRead threadId='thread-a' lastMessageAt={lastMessageAt}/>;}
const root=createRoot(document.getElementById('root'));
globalThis.__renderRead=(lastMessageAt,revision)=>root.render(<Fixture lastMessageAt={lastMessageAt} revision={revision}/>);`,
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
        name: 'inbox-read-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/actions$/ }, () => ({
            path: 'action',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: 'export const markInboxThreadReadAction=form=>globalThis.__read(form);',
            loader: 'ts',
          }));
        },
      },
    ],
  });
  await page.route('https://inbox-read.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html lang="de"><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto('https://inbox-read.test/');
  await page.addScriptTag({ content: result.outputFiles[0]!.text });
  const t0 = '2026-09-14T01:00:00.000Z';
  const t1 = '2026-09-14T01:05:00.000Z';
  await page.evaluate(`globalThis.__renderRead(${JSON.stringify(t0)}, 1)`);
  await expect.poll(() => page.evaluate('globalThis.__renderedRevision')).toBe(1);
  expect(await page.evaluate('globalThis.__reads')).toEqual([
    { id: 'thread-a', lastMessageAt: t0 },
  ]);

  // Der erste Serveraufruf ist noch offen; die neue Ansicht muss trotzdem t1 quittieren.
  await page.evaluate(`globalThis.__renderRead(${JSON.stringify(t1)}, 2)`);
  await expect.poll(() => page.evaluate('globalThis.__renderedRevision')).toBe(2);
  expect(await page.evaluate('globalThis.__reads')).toEqual([
    { id: 'thread-a', lastMessageAt: t0 },
    { id: 'thread-a', lastMessageAt: t1 },
  ]);
  await page.evaluate(`globalThis.__renderRead(${JSON.stringify(t1)}, 3)`);
  await expect.poll(() => page.evaluate('globalThis.__renderedRevision')).toBe(3);
  expect(await page.evaluate('globalThis.__reads.length')).toBe(2);
  await page.evaluate('globalThis.__pendingReads.forEach(resolve=>resolve({ok:true}))');
});
