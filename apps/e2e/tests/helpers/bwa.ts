import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';
const webRequire = createRequire(new URL('../../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
let bundle: Promise<string> | undefined;
function bwaBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React from 'react';
import {createRoot} from 'react-dom/client';
import {PlanWizard} from './src/app/portal/(protected)/bwa/plan/plan-wizard';
import {PlanListWithCompare} from './src/app/portal/(protected)/bwa/plan/plan-comparison';
import {PlanVsProjection} from './src/app/portal/(protected)/bwa/plan/plan-vs-projection';
import {BwaDashboard} from './src/components/bwa/bwa-dashboard';
import {TaxEstimatorCard} from './src/app/staff/(protected)/clients/[id]/bwa/[periodId]/tax-estimator-card';
globalThis.__calls=[];
const props=globalThis.__props;
for(const p of props.plans??[])p.updatedAt=new Date(p.updatedAt);
for(const p of props.periods??[]){p.fromDate=new Date(p.fromDate);p.toDate=new Date(p.toDate)}
const Component={wizard:PlanWizard,comparison:PlanListWithCompare,versus:PlanVsProjection,dashboard:BwaDashboard,tax:TaxEstimatorCard}[globalThis.__mode];
createRoot(document.getElementById('root')).render(<Component {...props} onCreate={async(input)=>{globalThis.__calls.push(input);return {ok:true,id:'synthetic-plan'}}}/>);`,
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
        name: 'bwa-navigation-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^next\/link$/ }, ({ path }) => ({
            path,
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents:
              "import React from 'react';export default function Link({href,children,...props}){return <a {...props} href={href} onClick={e=>e.preventDefault()}>{children}</a>}",
            loader: 'tsx',
            resolveDir: webRoot,
          }));
        },
      },
    ],
  }).then((r) => r.outputFiles[0]!.text);
  return bundle;
}
export async function mountBwa(
  page: Page,
  mode: 'wizard' | 'comparison' | 'versus' | 'dashboard' | 'tax',
  props: Record<string, unknown>,
) {
  const source = await bwaBundle();
  await page.addInitScript(
    ({ mode, props }) => Object.assign(globalThis, { __mode: mode, __props: props }),
    { mode, props },
  );
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://bwa.test') return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    if (url.pathname === '/fixture.js')
      return route.fulfill({ contentType: 'application/javascript', body: source });
    return route.abort();
  });
  await page.goto('http://bwa.test');
  await page.locator('#root > *').first().waitFor();
}
export const plan = {
  id: 'plan-a',
  name: 'Testplanung',
  year: 2026,
  status: 'FINAL',
  updatedAt: '2026-09-07T00:00:00Z',
  createdByType: 'STAFF',
  updatedByType: null,
  lines: [
    { axis: 'REVENUE', amount: 1000 },
    { axis: 'OTHER_INCOME', amount: 200 },
    { axis: 'PERSONNEL', amount: 300 },
    { axis: 'MATERIAL', amount: 200 },
    { axis: 'DEPRECIATION', amount: 50 },
    { axis: 'OTHER_COSTS', amount: 250 },
    { axis: 'TAXES', amount: 120 },
  ],
};
export const missingBase = {
  id: 'base-a',
  periodKey: '2025',
  label: 'Unvollständige BWA',
  periodType: 'YEAR',
  canApply: false,
  unavailableReason:
    'Für die automatische Vorbelegung fehlen eindeutige Positionen. Bitte manuell planen.',
  revenue: null,
  costs: 800,
  result: 700,
  resultBeforeTax: null,
  personnelCost: null,
  material: null,
  depreciation: null,
  otherIncome: null,
};
