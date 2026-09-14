import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// PORTAL-INBOX-SUBMISSION-001: echte React-UI; Actions und Datenrefresh sind simuliert.
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
let bundle: Promise<string> | undefined;

function controlsBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {InboxStaffControls} from './src/app/staff/(protected)/inbox/controls';
import {InboxComposer} from './src/app/portal/(protected)/inbox/composer';
globalThis.__calls=[];globalThis.__refreshes=0;globalThis.__batches=0;
globalThis.__reply=form=>{globalThis.__calls.push(Object.fromEntries(form));return new Promise((resolve,reject)=>{globalThis.__resolveReply=resolve;globalThis.__rejectReply=reject;});};
createRoot(document.getElementById('root')).render(globalThis.__portal?<InboxComposer mode={{kind:'reply',threadId:'thread-a'}}/>:<InboxStaffControls threadId='thread-a' status='OPEN' assignedStaffId='staff-a' currentStaffId='staff-a' staff={[{id:'staff-a',name:'Erika Musterfrau'}]}/>);`,
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
        name: 'inbox-controls-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^(next\/navigation|\.\/actions)$/ }, ({ path }) => ({
            path,
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents:
              path === 'next/navigation'
                ? 'export const useRouter=()=>({refresh(){globalThis.__refreshes++;},push(){}});'
                : [
                    'assignInboxThreadAction',
                    'claimInboxThreadAction',
                    'reopenInboxThreadAction',
                    'replyInboxThreadAction',
                    'resolveInboxThreadAction',
                    'addInboxMessageAction',
                    'createInboxThreadAction',
                  ]
                    .map((name) => `export const ${name}=form=>globalThis.__reply(form);`)
                    .join('\n') +
                  '\nexport const createInboxUploadBatchAction=async()=>({ok:true,batchId:"batch-"+(++globalThis.__batches)});' +
                  '\nexport const discardInboxUploadBatchAction=async()=>({ok:true});',
            loader: 'ts',
          }));
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

async function mountControls(page: Page, portal = false) {
  const source = await controlsBundle();
  await page.route('https://inbox-controls.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html lang="de"><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto('https://inbox-controls.test/');
  await page.evaluate((enabled) => {
    Object.assign(globalThis, { __portal: enabled });
  }, portal);
  await page.addScriptTag({ content: source });
  await expect(
    page.getByLabel(portal ? 'Nachricht' : 'Antwort an den Mandanten', { exact: true }),
  ).toBeVisible();
}

test('leert die Antwort nach verzögertem Erfolg und vergibt erst dann eine neue Mutation-ID', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mountControls(page);
  const reply = page.getByLabel('Antwort an den Mandanten');
  const save = page.getByRole('button', { name: 'Antwort speichern und Hinweis senden' });
  await reply.fill('Erste synthetische Antwort.');
  await save.click();
  await expect(page.getByRole('button', { name: 'Wird gespeichert …' })).toBeDisabled();
  await expect(reply).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Zuweisen', exact: true })).toBeDisabled();
  const first = await page.evaluate('globalThis.__calls[0]');
  expect(first).toMatchObject({ body: 'Erste synthetische Antwort.', threadId: 'thread-a' });
  await page.evaluate(
    'globalThis.__resolveReply({ok:true,mailWarning:"Hinweisversand nicht bestätigt."})',
  );
  await expect(reply).toHaveValue('');
  await expect.poll(() => page.evaluate('globalThis.__refreshes')).toBe(1);
  await expect(save).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('Hinweisversand nicht bestätigt.');
  expect(errors).toEqual([]);

  await reply.fill('Zweite synthetische Antwort.');
  await save.click();
  const second = await page.evaluate('globalThis.__calls[1]');
  expect(second.clientMutationId).not.toBe(first.clientMutationId);
  expect(second.body).toBe('Zweite synthetische Antwort.');
  await page.evaluate('globalThis.__resolveReply({ok:true})');
  await expect(reply).toHaveValue('');
  await expect.poll(() => page.evaluate('globalThis.__refreshes')).toBe(2);
  expect(errors).toEqual([]);
});

test('leert eine erfolgreiche Portalantwort samt Anlagen auch bei unveränderter Threadroute', async ({
  page,
}) => {
  await mountControls(page, true);
  let uploads = 0;
  await page.route('**/api/portal/inbox/batches/*/files', (route) => {
    uploads++;
    return route.fulfill({ json: { attachmentId: 'attachment-a' } });
  });
  const reply = page.getByLabel('Nachricht', { exact: true });
  const files = page.getByLabel('Anlagen (optional)');
  const save = page.getByRole('button', { name: 'Nachricht senden', exact: true });
  await reply.fill('Portalantwort mit Anlage.');
  await files.setInputFiles({
    name: 'beispiel.xml',
    mimeType: 'application/xml',
    buffer: Buffer.from('<beispiel/>'),
  });
  await save.click();
  await expect.poll(() => page.evaluate('globalThis.__calls.length')).toBe(1);
  await expect(reply).toBeDisabled();
  await expect(files).toBeDisabled();
  const first = await page.evaluate('globalThis.__calls[0]');
  expect(first).toMatchObject({ body: 'Portalantwort mit Anlage.', batchId: 'batch-1' });
  await page.evaluate('globalThis.__resolveReply({ok:true,threadId:"thread-a"})');
  await expect(reply).toHaveValue('');
  await expect(files).toHaveValue('');
  await expect(page.getByText('Nachricht technisch eingegangen.', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate('globalThis.__refreshes')).toBe(1);
  await reply.fill('Neue Antwort ohne Anlage.');
  await save.click();
  await expect.poll(() => page.evaluate('globalThis.__calls.length')).toBe(2);
  const second = await page.evaluate('globalThis.__calls[1]');
  expect(second.clientMutationId).not.toBe(first.clientMutationId);
  expect(second.batchId).toBeUndefined();
  expect(uploads).toBe(1);
  expect(await page.evaluate('globalThis.__batches')).toBe(1);
  await page.evaluate('globalThis.__resolveReply({ok:true,threadId:"thread-a"})');
  await expect(reply).toHaveValue('');
});

for (const portal of [false, true]) {
  test(`${portal ? 'Portal' : 'Kanzlei'}: zeigt einen geworfenen Netzwerkfehler an und behält die Mutation für den Retry`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await mountControls(page, portal);
    let uploads = 0;
    if (portal) {
      await page.route('**/api/portal/inbox/batches/*/files', (route) => {
        uploads++;
        return route.fulfill({ json: { attachmentId: 'attachment-a' } });
      });
      await page.getByLabel('Anlagen (optional)').setInputFiles({
        name: 'retry.xml',
        mimeType: 'application/xml',
        buffer: Buffer.from('<retry/>'),
      });
    }
    const reply = page.getByLabel(portal ? 'Nachricht' : 'Antwort an den Mandanten', {
      exact: true,
    });
    const save = page.getByRole('button', {
      name: portal ? 'Nachricht senden' : 'Antwort speichern und Hinweis senden',
      exact: true,
    });
    await reply.fill('Unveränderter Entwurf für den Retry.');
    await save.click();
    await expect.poll(() => page.evaluate('globalThis.__calls.length')).toBe(1);
    await page.evaluate('globalThis.__rejectReply(new Error("Verbindung abgebrochen"))');
    await expect(page.getByRole('alert')).toContainText('erneut');
    await expect(reply).toHaveValue('Unveränderter Entwurf für den Retry.');
    await expect(save).toBeEnabled();
    expect(await page.evaluate('globalThis.__refreshes')).toBe(0);
    expect(errors).toEqual([]);
    await save.click();
    await expect.poll(() => page.evaluate('globalThis.__calls.length')).toBe(2);
    expect(await page.evaluate('globalThis.__calls[1]')).toEqual(
      await page.evaluate('globalThis.__calls[0]'),
    );
    if (portal) {
      expect(uploads).toBe(1);
      expect(await page.evaluate('globalThis.__batches')).toBe(1);
    }
    await page.evaluate('globalThis.__resolveReply({ok:true,threadId:"thread-a"})');
    await expect(reply).toHaveValue('');
  });
}

test('behält bei einem Serverfehler den Entwurf und dieselbe Mutation-ID für den Retry', async ({
  page,
}) => {
  await mountControls(page);
  const reply = page.getByLabel('Antwort an den Mandanten');
  const save = page.getByRole('button', { name: 'Antwort speichern und Hinweis senden' });
  await reply.fill('Antwort für einen sicheren Wiederholungsversuch.');
  await save.click();
  await page.evaluate('globalThis.__resolveReply({ok:false,error:"Bitte erneut versuchen."})');
  await expect(page.getByRole('alert')).toContainText('Bitte erneut versuchen.');
  await expect(reply).toHaveValue('Antwort für einen sicheren Wiederholungsversuch.');
  await expect(save).toBeEnabled();
  expect(await page.evaluate('globalThis.__refreshes')).toBe(0);
  await save.click();
  expect(await page.evaluate('globalThis.__calls[1]')).toEqual(
    await page.evaluate('globalThis.__calls[0]'),
  );
  await page.evaluate('globalThis.__resolveReply({ok:false,error:"Weiterhin nicht erreichbar."})');
  await expect(save).toBeEnabled();
});
