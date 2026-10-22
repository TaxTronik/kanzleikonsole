// Local, synthetic browser fixture for GWG-OCR-ASSIST-001. No application DB or identity data.
import { build } from 'vite';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(app, '../../.codex-run/identity-smoke');
const output = path.join(root, 'dist');
await mkdir(root, { recursive: true });
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (const text of [
  'Name: MUSTERMANN\nVornamen: ERIKA\nGeburtsdatum: 12.08.1964',
  'Anschrift\n10115 BERLIN\nMUSTERSTRASSE 12',
]) {
  const page = pdf.addPage([800, 500]);
  page.drawText(text, { x: 50, y: 400, size: 30, font, lineHeight: 45 });
}
const pdfBytes = await pdf.save();
await writeFile(
  path.join(root, 'index.html'),
  '<html lang="de"><head><meta charset="utf-8"><title>Lokale Ausweishilfe – synthetischer Funktionstest</title></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>',
);
await writeFile(
  path.join(root, 'fixture.tsx'),
  `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IdentityCapture } from '@/components/gwg/identity-capture';
import { mrzCheckDigit } from '@/lib/gwg/identity-mrz';
// Synthetische TD1-Zone (keine reale Person): Nummer, Daten und Gesamtprüfziffer nach ICAO 9303.
const mrz1 = ('IDD<<L01X00T47' + mrzCheckDigit('L01X00T47')).padEnd(30, '<');
const mrz2Body = ('640812' + mrzCheckDigit('640812') + '<301231' + mrzCheckDigit('301231') + 'D<<').padEnd(29, '<');
const mrz2 = mrz2Body + mrzCheckDigit(mrz1.slice(5) + mrz2Body.slice(0, 7) + mrz2Body.slice(8, 15) + mrz2Body.slice(18, 29));
const mrz3 = 'MUSTERMANN<<ERIKA'.padEnd(30, '<');
function Fixture() {
 const [values, setValues] = useState({fullName:'Vorhandener Name'});
 const [views, setViews] = useState([]);
 const [kind,setKind] = useState('pdf');
 const [file,setFile] = useState(null);
 const [audience,setAudience] = useState("staff");
 const versionId = '00000000-0000-4000-8000-000000000010';
 async function load() {
   if(kind === 'broken') return {blob:new Blob(['synthetic-invalid-pdf'],{type:'application/pdf'}),versionId};
   if(kind === 'pdf') return {blob:await (await fetch('/synthetic.pdf')).blob(),versionId};
   // Nur lokal: eigene Testdatei (z. B. veröffentlichtes Muster), bleibt im Browser.
   if(kind === 'file') { if(!file) throw new Error('Bitte zuerst eine Testdatei wählen.'); return {blob:file,versionId}; }
   if(kind === 'mrz') {
     const c=document.createElement('canvas'); c.width=1300;c.height=520;
     const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';
     x.font='34px Arial';x.fillText('Behörde/Authority/Autorité',50,70);x.font='40px Arial';x.fillText('STADT KÖLN',50,125);
     x.font='44px monospace';[mrz1,mrz2,mrz3].forEach((line,i)=>x.fillText(line,50,300+i*70));
     return {blob:await new Promise(resolve=>c.toBlob(resolve,'image/png')),versionId};
   }
   const c=document.createElement('canvas'); c.width=1200;c.height=600;
   const x=c.getContext('2d');x.fillStyle='white';x.fillRect(0,0,c.width,c.height);x.fillStyle='black';x.font='40px Arial';
   ['Name: MUSTERMANN','Vornamen: ERIKA','Geburtsdatum: 12.08.1964'].forEach((line,i)=>x.fillText(line,50,100+i*80));
   return {blob:await new Promise(resolve=>c.toBlob(resolve,kind==='png'?'image/png':'image/jpeg')),versionId};
 }
 return <main style={{maxWidth:1000,margin:'32px auto',fontFamily:'sans-serif'}}><h1>Synthetischer Ausweistest</h1>
 <p>Keine echten Personendaten. Übernahmen und Seitenverweise bleiben nur im Arbeitsspeicher.</p>
 <label>Testformat<select value={kind} onChange={e=>{setKind(e.target.value);setViews([])}}><option value="pdf">PDF mit zwei Seiten</option><option value="png">PNG</option><option value="jpg">JPG</option><option value="broken">Unlesbare PDF</option><option value="mrz">Rückseite mit MRZ</option><option value="file">Eigene Testdatei (nur lokal)</option></select></label>
 <label> Zielgruppe <select value={audience} onChange={e=>setAudience(e.target.value)}><option value="staff">Kanzlei</option><option value="client">Mandant (Onboarding)</option></select></label>
 {kind === 'file' && <label> Testdatei <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e=>setFile(e.target.files?.[0] ?? null)}/></label>}
 <IdentityCapture key={kind + audience + (file?.name ?? '')} audience={audience} sideSources={audience === 'client' ? {[kind === 'mrz' ? 'back' : 'front']: versionId} : undefined} sources={[{id:versionId,label:'Synthetisches Muster',load}]} current={values} onApply={data=>setValues({...values,...data})} initialViews={views} onViewChange={v=>setViews([...views.filter(x=>x.side!==v.side),v])}/>
 <h2>Übernommene Angaben</h2><output>{JSON.stringify(values)}</output><h2>Gespeicherte Seitenverweise</h2><pre>{JSON.stringify(views,null,2)}</pre>
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`,
);
await build({
  configFile: false,
  root,
  publicDir: false,
  resolve: { alias: { '@': path.join(app, 'src') } },
  esbuild: { jsx: 'automatic' },
  build: { outDir: output, emptyOutDir: false },
  logLevel: 'warn',
  worker: { format: 'es' },
});
if (process.argv.includes('--build-only')) process.exit(0);
const assetRoot = path.join(app, 'public');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.wasm': 'application/wasm',
  '.gz': 'application/octet-stream',
  '.pdf': 'application/pdf',
};
const requests = [];
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost:4319').pathname;
    requests.push(pathname);
    const worker = pathname.startsWith('/identity-assets/');
    res.setHeader(
      'Content-Security-Policy',
      worker
        ? "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'"
        : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; object-src 'none'",
    );
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/requests') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(requests));
      return;
    }
    if (pathname === '/synthetic.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.end(pdfBytes);
      return;
    }
    const base = worker ? assetRoot : output;
    const file = path.resolve(base, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(base + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(4319, '127.0.0.1', () =>
  console.log('Synthetic identity fixture: http://localhost:4319'),
);
