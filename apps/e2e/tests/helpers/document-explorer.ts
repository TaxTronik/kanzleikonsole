import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';

// Use the already installed web build tool; no app server, database or new dependency.
const webRequire = createRequire(new URL('../../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));

export const folderA = { id: 'folder-a', name: 'Ausgangsordner', parentId: null };
export const folderB = { id: 'folder-b', name: 'Zielordner', parentId: null };
export const fileA = {
  kind: 'file',
  id: 'file-a',
  name: 'Alpha.pdf',
  mimeType: 'application/pdf',
  typeName: 'Allgemein',
  typeId: null,
  tier: 'NONE',
  sizeBytes: 123,
  createdAt: '2026-09-07T10:00:00Z',
  deletedAt: null,
  shared: false,
};
export const fileB = { ...fileA, id: 'file-b', name: 'Beta.pdf' };
export const browserProps = {
  variant: 'browser',
  crumbs: [{ label: 'Ausgangsordner', href: '/staff/documents?client=client-a&folder=folder-a' }],
  entries: [fileA],
  scope: { clientId: 'client-a', typeParam: 'business' },
  folders: [folderA, folderB],
  currentFolderId: folderA.id,
  deleted: false,
  q: '',
};

let bundle: Promise<string> | undefined;
function explorerBundle(): Promise<string> {
  bundle ??= build({
    stdin: {
      contents: `import React, {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DocumentExplorer} from './src/components/document-explorer';
globalThis.__documentActions=[];
globalThis.__router={push:()=>{},refresh:()=>{}};
function Fixture(){
 const [props,setProps]=useState(globalThis.__explorerProps);
 useEffect(()=>{
  const update=event=>setProps(previous=>({...previous,...event.detail}));
  window.addEventListener('explorer-props',update);
  return()=>window.removeEventListener('explorer-props',update);
 },[]);
 return <DocumentExplorer {...props}/>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: webRoot,
      loader: 'tsx',
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
        name: 'isolated-document-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^next\/(link|navigation)$/ }, ({ path }) => ({
            path,
            namespace: 'fixture',
          }));
          builder.onResolve(
            { filter: /^@\/app\/staff\/\(protected\)\/documents\/(actions|folder-actions)$/ },
            () => ({ path: 'actions', namespace: 'fixture' }),
          );
          builder.onResolve(
            { filter: /^@\/components\/(document-upload-button|document-preview)$/ },
            ({ path }) => ({ path, namespace: 'fixture' }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
            const modules: Record<string, string> = {
              'next/navigation': 'export const useRouter=()=>globalThis.__router;',
              'next/link': `import React from 'react';
export default function Link({href,children,scroll,prefetch,...props}){
 return <a {...props} href={href} onClick={event=>event.preventDefault()}>{children}</a>;
}`,
              actions: `const action=name=>async input=>{
 globalThis.__documentActions.push({action:name,input});return {ok:true};
};
export const setDocumentFolderAction=action('setDocumentFolder');
export const moveFolderAction=action('moveFolder');
export const deleteFolderAction=action('deleteFolder');
export const createFolderAction=action('createFolder');
export const renameFolderAction=action('renameFolder');
export const softDeleteDocumentAction=action('softDeleteDocument');
export const restoreDocumentAction=action('restoreDocument');
export const setDocumentShareAction=action('setDocumentShare');
export const retagDocumentAction=action('retagDocument');`,
              '@/components/document-upload-button': `import React from 'react';
export const DocumentUploadButton=({folderId})=><button type="button" data-upload-folder={folderId??''}>Hochladen</button>;`,
              '@/components/document-preview': 'export const DocumentPreviewModal=()=>null;',
            };
            return { contents: modules[path]!, loader: 'tsx', resolveDir: webRoot };
          });
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

export async function mountDocumentExplorer(page: Page, props: Record<string, unknown>) {
  const source = await explorerBundle();
  await page.addInitScript(`globalThis.__explorerProps=${JSON.stringify(props)};`);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://document-explorer.test') return route.abort();
    if (url.pathname === '/') {
      return route.fulfill({
        contentType: 'text/html',
        body: '<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    }
    if (url.pathname === '/fixture.js') {
      return route.fulfill({ contentType: 'application/javascript', body: source });
    }
    return route.abort();
  });
  await page.goto('http://document-explorer.test');
  await page.getByPlaceholder(/In (diesem Ordner|Auswahl) suchen/).waitFor();
}

export async function updateDocumentExplorer(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('explorer-props', { detail }));
  }, patch);
}
