import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';

const webRequire = createRequire(new URL('../../../web/package.json', import.meta.url));
const { build } = createRequire(webRequire.resolve('tsx'))('esbuild') as typeof import('esbuild');
const webRoot = dirname(webRequire.resolve('./package.json'));
let bundle: Promise<string> | undefined;

function ticketBundle() {
  bundle ??= build({
    stdin: {
      contents: `import React,{useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {ReminderDetailView} from './src/app/staff/(protected)/reminders/[id]/reminder-detail-view';
import {RemindersOverview} from './src/app/staff/(protected)/reminders/reminders-overview';
import {NewReminderForm} from './src/app/staff/(protected)/reminders/new-reminder-form';
import {RemindersBlock} from './src/app/staff/(protected)/clients/[id]/reminders/reminders-block';
globalThis.__calls=[];
globalThis.__router={push:url=>globalThis.__calls.push({name:'push',input:url}),refresh:()=>globalThis.__calls.push({name:'refresh'})};
globalThis.__action=async(name,input)=>{
 globalThis.__calls.push({name,input});
 if(globalThis.__deferAction){globalThis.__deferAction=false;return new Promise(resolve=>globalThis.__resolveAction=resolve);}
 return {ok:true,id:'new-ticket',ticketNumber:103};
};
function Fixture(){
 const [props,setProps]=useState(globalThis.__props);
 useEffect(()=>{const update=event=>setProps(p=>({...p,...event.detail}));window.addEventListener('ticket-props',update);return()=>window.removeEventListener('ticket-props',update)},[]);
 if(globalThis.__mode==='overview')return <RemindersOverview {...props}/>;
 if(globalThis.__mode==='new')return <NewReminderForm {...props}/>;
 if(globalThis.__mode==='client')return <RemindersBlock {...props}/>;
 return <ReminderDetailView {...props}/>;
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
        name: 'reminder-ticket-isolated-boundaries',
        setup(builder) {
          builder.onResolve({ filter: /^next\/(link|navigation)$/ }, ({ path }) => ({
            path,
            namespace: 'fixture',
          }));
          builder.onResolve({ filter: /(?:\/reminders\/actions|^\.\/actions)$/ }, () => ({
            path: 'actions',
            namespace: 'fixture',
          }));
          builder.onResolve(
            { filter: /^@\/components\/document-(upload-button|actions)$/ },
            ({ path }) => ({ path, namespace: 'fixture' }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
            let contents: string;
            if (path === 'next/navigation')
              contents = 'export const useRouter=()=>globalThis.__router;';
            else if (path === 'next/link')
              contents =
                "import React from 'react';export default function Link({href,children,...props}){return <a {...props} href={href} onClick={e=>e.preventDefault()}>{children}</a>}";
            else if (path === 'actions')
              contents = [
                'markReminderDoneAction',
                'reopenReminderAction',
                'cloneReminderAction',
                'addReminderNoteAction',
                'setReminderAssigneesAction',
                'setReminderPriorityAction',
                'archiveReminderAction',
                'restoreReminderAction',
                'createReminderAction',
                'submitResearchResultAction',
              ]
                .map(
                  (name) =>
                    `export const ${name}=(...args)=>globalThis.__action('${name}',args.length>1?Object.fromEntries(args[1]):args[0]);`,
                )
                .join('\n');
            else if (path.endsWith('document-upload-button'))
              contents =
                "import React from 'react';export const DocumentUploadButton=({buttonLabel,onUploaded})=><button onClick={()=>globalThis.__deferUpload?globalThis.__resolveUpload=onUploaded:onUploaded()}>{buttonLabel}</button>;";
            else
              contents =
                "import React from 'react';export const DocumentActions=({documentId,documentTitle})=><a href={'/api/staff/documents/'+documentId+'/download'}>{documentTitle} herunterladen</a>;";
            return { contents, loader: 'tsx', resolveDir: webRoot };
          });
        },
      },
    ],
  }).then((result) => result.outputFiles[0]!.text);
  return bundle;
}

export async function mountReminderTickets(
  page: Page,
  mode: 'detail' | 'overview' | 'new' | 'client',
  props: Record<string, unknown>,
) {
  const source = await ticketBundle();
  await page.addInitScript(
    ({ mode, props }) => Object.assign(globalThis, { __mode: mode, __props: props }),
    { mode, props },
  );
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://reminder-tickets.test') return route.abort();
    if (url.pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<html><head><style>.hidden{display:none}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',
      });
    if (url.pathname === '/fixture.js')
      return route.fulfill({ contentType: 'application/javascript', body: source });
    return route.abort();
  });
  await page.goto('http://reminder-tickets.test');
  await page.locator('#root > *').waitFor();
}

export const ticketDetail = {
  commentsPage: 1,
  commentsTotal: 1,
  commentsPageSize: 200,
  attachmentsPage: 1,
  attachmentsTotal: 0,
  attachmentsPageSize: 50,
  id: '11111111-1111-4111-8111-111111111111',
  ticketNumber: 101,
  subject: 'Belege prüfen',
  clientId: null,
  clientName: null,
  dueDate: '2026-09-14T00:00:00.000Z',
  priority: 'NORMAL',
  doneAt: null,
  doneByName: null,
  archivedAt: null,
  createdByStaff: 'staff-a',
  createdByName: 'Anna Beispiel',
  canArchive: false,
  canRestore: false,
  originResearchAnalysisId: null,
  originResearchMarkingId: null,
  assignees: [{ staffId: 'staff-a', fullName: 'Anna Beispiel' }],
  begriff: null,
  normAnker: [],
  fundstelle: null,
  auftrag:
    'Bitte #102 beachten. #999 bleibt Text. URL https://example.test/#102 und abc#102 bleiben ebenfalls Text.',
  description:
    'Bitte #102 beachten. #999 bleibt Text. URL https://example.test/#102 und abc#102 bleiben ebenfalls Text.',
  researchAnalysisId: null,
  researchMarkingId: null,
  phoneNote: null,
  vorgaenger: [],
  folgestufen: [],
  attachments: [],
  discussion: [
    {
      id: 'note-1',
      body: '@Anna Beispiel siehe #102 und #999.',
      createdAt: '2026-09-07T10:00:00.000Z',
      staffId: 'staff-a',
      staffName: 'Anna Beispiel',
    },
  ],
  references: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      ticketNumber: 102,
      subject: 'Zugehöriger Auftrag',
      doneAt: null,
      archivedAt: null,
      direction: 'outgoing',
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      ticketNumber: 103,
      subject: 'Späterer Auftrag',
      doneAt: '2026-09-07T00:00:00.000Z',
      archivedAt: '2026-09-07T01:00:00.000Z',
      direction: 'incoming',
    },
  ],
};

export const ticketProps = {
  detail: ticketDetail,
  currentStaffId: 'staff-a',
  canSteer: true,
  staffOptions: [
    { id: 'staff-a', fullName: 'Anna Beispiel' },
    { id: 'staff-b', fullName: 'Bert Beispiel' },
  ],
};
