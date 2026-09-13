import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Fachkatalog: ACCESS-STAFF-PERMISSION-001, ACCESS-TENANT-RLS-001
// Echte UI; nur die Server-Action und ihr anschließender Datenrefresh sind simuliert.
const webRequire = createRequire(new URL('../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
let bundle: Promise<string> | undefined;

function profileBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {ProfessionalProfileForm} from './src/app/staff/(protected)/admin/users/row-forms';
globalThis.__calls=[];
globalThis.__action=async input=>{
 globalThis.__calls.push(input);
 const result=await new Promise(resolve=>globalThis.__resolveAction=resolve);
 if(result.ok)window.dispatchEvent(new CustomEvent('profile-props',{detail:{isProfessional:input.isProfessional,advisorNumber:input.datevAdvisorNumber.trim()||null,source:'manual'}}));
 return result;
};
function Fixture(){
 const [props,setProps]=useState(globalThis.__props);
 useEffect(()=>{const update=event=>setProps(p=>({...p,...event.detail}));window.addEventListener('profile-props',update);return()=>window.removeEventListener('profile-props',update)},[]);
 return <ProfessionalProfileForm {...props}/>;
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
        name: 'professional-profile-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^next\/link$/ }, () => ({
            path: 'link',
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /^(\.\/actions|\.\.\/skills\/actions)$/ }, () => ({
            path: 'actions',
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
            contents:
              path === 'link'
                ? "import React from 'react';export default function Link(props){return <a {...props}/>;}"
                : [
                    'beginHardwareRecoveryStepUpAction',
                    'recoverHardwareAccessAction',
                    'resetPasswordAction',
                    'resetTotpAction',
                    'setActiveAction',
                    'setRolesAction',
                    'setPermissionsAction',
                    'setProfessionalProfileAction',
                    'setStaffSkillsAction',
                  ]
                    .map((name) => `export const ${name}=input=>globalThis.__action(input);`)
                    .join('\n'),
            loader: 'tsx',
            resolveDir: webRoot,
          }));
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

async function mountProfile(page: Page, overrides: Record<string, unknown> = {}) {
  const source = await profileBundle();
  const props = {
    userId: 'staff-a',
    isProfessional: true,
    advisorNumber: '001234',
    source: 'manual',
    ...overrides,
  };
  await page.addInitScript(`globalThis.__props=${JSON.stringify(props)};`);
  await page.route('http://professional-profile.test/**', (route) =>
    route.fulfill(
      route.request().url().endsWith('/fixture.js')
        ? { contentType: 'application/javascript', body: source }
        : {
            contentType: 'text/html',
            body: '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
          },
    ),
  );
  await page.goto('http://professional-profile.test/');
  await expect(page.getByText('Berufliches Profil', { exact: true })).toBeVisible();
}

test('zeigt gespeicherte Werte und verwirft den vollständigen Entwurf beim Abbrechen', async ({
  page,
}) => {
  await mountProfile(page);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByText('001234', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await expect(page.getByRole('textbox')).toBeFocused();
  await page.getByRole('textbox').fill('009999');
  await page.getByRole('checkbox', { name: 'Berufsträger', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  expect(await page.evaluate('globalThis.__calls')).toEqual([]);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText('001234', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await expect(page.getByRole('textbox')).toHaveValue('001234');
  await expect(page.getByRole('checkbox', { name: 'Berufsträger', exact: true })).toBeChecked();
});

test('speichert erst ausdrücklich, sperrt den laufenden Submit und zeigt den neuen Stand', async ({
  page,
}) => {
  await mountProfile(page);
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await page.getByRole('textbox').fill('000042');
  expect(await page.evaluate('globalThis.__calls')).toEqual([]);
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByRole('textbox')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Abbrechen', exact: true })).toBeDisabled();
  expect(await page.evaluate('globalThis.__calls')).toEqual([
    { userId: 'staff-a', isProfessional: true, datevAdvisorNumber: '000042' },
  ]);
  await page.evaluate('globalThis.__resolveAction({ok:true})');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText('000042', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Gespeichert.');
});

test('erhält den Entwurf bei einem Serverfehler und erlaubt erneutes Speichern', async ({
  page,
}) => {
  await mountProfile(page);
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await page.getByRole('textbox').fill('000042');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await page.evaluate('globalThis.__resolveAction({ok:false,error:"Bitte erneut versuchen."})');
  await expect(page.getByRole('status')).toHaveText('Bitte erneut versuchen.');
  await expect(page.getByRole('textbox')).toHaveValue('000042');
  await expect(page.getByRole('button', { name: 'Speichern', exact: true })).toBeEnabled();
});

test('erhält die ausdrückliche Entzugsbestätigung und zeigt Zuordnungslücken nach Erfolg', async ({
  page,
}) => {
  await mountProfile(page);
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Berufsträger', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Berufsträgerqualifikation entziehen' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate('globalThis.__calls')).toEqual([]);
  await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await expect(page.getByRole('textbox')).toBeEnabled();
  expect(await page.evaluate('globalThis.__calls')).toEqual([]);
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await dialog.getByRole('button', { name: 'Entziehen', exact: true }).click();
  await expect.poll(() => page.evaluate('globalThis.__calls.length')).toBe(1);
  await page.evaluate(
    'globalThis.__resolveAction({ok:true,assignmentGaps:[{id:"client-a",name:"Mandat A"}]})',
  );
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText(
    '1 Mandat(e) ohne aktiven qualifizierten Berufsträger:',
  );
  await expect(page.getByRole('link', { name: 'Mandat A' })).toHaveAttribute(
    'href',
    '/staff/clients/client-a/edit',
  );
});

test('respektiert gesperrte Zielkonten und zeigt fehlende Nummer sowie Legacy-Herkunft', async ({
  page,
}) => {
  await mountProfile(page, { disabled: true, advisorNumber: null, source: 'legacy' });
  await expect(page.getByRole('button', { name: 'Bearbeiten', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText('Nicht hinterlegt', { exact: true })).toBeVisible();
  await expect(page.getByText(/Aus bestehender Mandatszuordnung übernommen/)).toBeVisible();
  expect(await page.evaluate('globalThis.__calls')).toEqual([]);
});
