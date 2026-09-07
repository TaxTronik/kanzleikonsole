import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';

const webRequire = createRequire(new URL('../../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
let bundle: Promise<string> | undefined;

function subsumtionBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {SubsumtionWorkspace} from './src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-workspace';
import {SubsumtionDocument} from './src/app/staff/(protected)/clients/[id]/subsumtion/subsumtion-document';
globalThis.__calls=[];
globalThis.__router={push:url=>globalThis.__calls.push({name:'push',input:url}),refresh:()=>{}};
globalThis.__action=async(name,input)=>{
 globalThis.__calls.push({name,input});
 if(name==='llmStatusAction')return {ok:false,error:'Fixture has no external engine'};
 if(name==='importClientDocAction'||name==='importDocTextAction'){
  return await new Promise(resolve=>globalThis.__resolveImport=resolve);
 }
 if(name==='reformatAnalysisAction' && globalThis.__deferSave){globalThis.__deferSave=false;return await new Promise(resolve=>globalThis.__resolveSave=resolve);}
 if(name==='reformatAnalysisAction' && globalThis.__failSaves>0){globalThis.__failSaves--;return {ok:false,error:'Synthetic save failure'};}
 return {ok:true,analysisId:'synthetic-analysis'};
};
function Fixture(){
 const [props,setProps]=useState(globalThis.__props);
 useEffect(()=>{const update=event=>setProps(p=>({...p,...event.detail}));window.addEventListener('subsumtion-props',update);return()=>window.removeEventListener('subsumtion-props',update)},[]);
 return globalThis.__mode==='document'
  ? <SubsumtionDocument {...props} onSaveFormat={doc=>globalThis.__action('reformatAnalysisAction',{doc})}/>
  : <SubsumtionWorkspace {...props}/>;
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
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'subsumtion-isolated-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^next\/(link|navigation)$/ }, ({ path }) => ({
            path,
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /^\.\/actions$/ }, () => ({
            path: 'actions',
            namespace: 'fixture',
          }));
          // The editor, toolbar, selection list, filters and workspace remain real.
          // Independent business panels are outside these editor regressions.
          builder.onResolve(
            {
              filter:
                /^\.\/(marking-panel|new-marking-panel|research-composer|research-view|export-panel)$/,
            },
            ({ path }) => ({ path, namespace: 'fixture' }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
            const panels: Record<string, string> = {
              './marking-panel': 'MarkingPanel',
              './new-marking-panel': 'NewMarkingPanel',
              './research-composer': 'ResearchComposer',
              './research-view': 'ResearchView',
              './export-panel': 'ExportPanel',
            };
            let contents: string;
            if (path === 'next/navigation')
              contents = 'export const useRouter=()=>globalThis.__router;';
            else if (path === 'next/link')
              contents =
                "import React from 'react';export default function Link({href,children,...props}){return <a {...props} href={href} onClick={e=>e.preventDefault()}>{children}</a>}";
            else if (path === 'actions')
              contents = [
                'analyzeAction',
                'importDocTextAction',
                'importClientDocAction',
                'requestLlmAction',
                'archiveAnalysisAction',
                'reformatAnalysisAction',
                'llmStatusAction',
                'reanalyzeAction',
                'setAnalysisVertraulichAction',
              ]
                .map((name) => `export const ${name}=input=>globalThis.__action('${name}',input);`)
                .join('\n');
            else contents = `export const ${panels[path]}=()=>null;`;
            return { contents, loader: 'tsx', resolveDir: webRoot };
          });
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

export async function mountSubsumtion(
  page: Page,
  mode: 'workspace' | 'document',
  props: Record<string, unknown>,
  failSaves = 0,
) {
  const source = await subsumtionBundle();
  await page.addInitScript(
    ({ mode, props, failSaves }) =>
      Object.assign(globalThis, { __mode: mode, __props: props, __failSaves: failSaves }),
    { mode, props, failSaves },
  );
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://subsumtion.test') return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<html><head><style>.hidden{display:none}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    if (url.pathname === '/fixture.js')
      return route.fulfill({ contentType: 'application/javascript', body: source });
    return route.abort();
  });
  await page.goto('http://subsumtion.test');
  await page.locator('.tiptap').waitFor();
}

export const composeProps = {
  clientId: 'client-a',
  staffOptions: [],
  engineConfigured: true,
  initial: null,
  clientDocuments: [{ id: 'file-a', title: 'Importdatei', mimeType: 'text/plain', typeName: '' }],
};
export const reviewDocumentProps = {
  analyzed: true,
  canEdit: true,
  initialDoc: null,
  initialText: 'Alpha Beta',
  sourceText: 'Alpha Beta',
};
