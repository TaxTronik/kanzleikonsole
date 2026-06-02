// =============================================================================
// Report-Modell → PDF (pdfkit). Reiner Renderer, hängt nur am ReportModel.
//
// pdfkit ist serverExternalPackages (next.config) — lädt seine Standard-Fonts
// zur Laufzeit aus node_modules, darf nicht gebündelt werden.
// =============================================================================

import PDFDocument from 'pdfkit';
import { DISCLAIMER, type ReportModel, type ReportToken } from './report-types';

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// Annotierten Sachverhalt selbst Wort für Wort setzen (KEIN pdfkit-`continued`):
// dessen Inline-Fluss verrutscht, sobald Tokens Zeilenumbrüche (Absätze) tragen —
// daher die überlappenden Stellen. Hier deterministisch: Wörter messen, bei
// Zeilenende umbrechen, Markierungen farbig + Marker [n] inline, \n = Umbruch,
// \n\n = Leerzeile.
function drawAnnotated(
  doc: PDFKit.PDFDocument,
  tokens: ReportToken[],
  geom: { left: number; right: number; bottom: number; fontSize: number },
): void {
  const { left, right, bottom, fontSize } = geom;
  doc.fontSize(fontSize).font('Helvetica');
  const lineHeight = doc.currentLineHeight() + 2;
  const spaceW = doc.widthOfString(' ');
  const ctx = { x: left, y: doc.y };

  const newline = (n = 1) => { ctx.x = left; ctx.y += lineHeight * n; };
  const ensure = () => {
    if (ctx.y + lineHeight > bottom) { doc.addPage(); ctx.y = doc.page.margins.top; ctx.x = left; }
  };
  const piece = (s: string, color: string, bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
    const w = doc.widthOfString(s);
    if (ctx.x + w > right && ctx.x > left) newline(); // Zeilenumbruch vor zu breitem Wort
    ensure();
    doc.fillColor(color).text(s, ctx.x, ctx.y, { lineBreak: false });
    ctx.x += w;
  };

  for (const tok of tokens) {
    if (tok.kind === 'marker') {
      piece(`[${tok.nr}]`, tok.color, true);
      continue;
    }
    const color = tok.color ?? '#111111';
    const lines = tok.text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      if (li > 0) newline(); // jedes \n = Umbruch (\n\n → Leerzeile)
      const words = lines[li]!.split(' ');
      for (let wi = 0; wi < words.length; wi++) {
        if (wi > 0) ctx.x += spaceW; // Leerzeichen zwischen den Wörtern
        if (words[wi]) piece(words[wi]!, color, false);
      }
    }
  }
  doc.x = left;
  doc.y = ctx.y + lineHeight;
}

function metaLine(model: ReportModel): string {
  return [
    model.clientName ? `Mandant: ${model.clientName}` : null,
    `Erstellt: ${model.createdAt.toLocaleDateString('de-DE')}`,
    `Markierungen: ${model.counts.gesamt} (${model.counts.eigen} eigene)`,
    `Katalog ${model.katalogVersion} · Engine ${model.engineVersion}`,
    model.llmEnriched ? 'KI-vertieft' : null,
    `SHA-256: ${model.textHash}`,
  ]
    .filter(Boolean)
    .join('  ·  ');
}

export async function renderPdf(model: ReportModel): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
  const done = toBuffer(doc);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const bottom = doc.page.height - doc.page.margins.bottom;

  // --- Kopf ---
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111').text(model.title, { width: contentWidth });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8).fillColor('#666666').text(metaLine(model), { width: contentWidth });
  doc.moveDown(0.6);

  // --- Disclaimer ---
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#8A6D00').text(DISCLAIMER, { width: contentWidth, align: 'justify' });
  doc.moveDown(0.8);

  // --- Sachverhalt (annotiert: markierte Stellen farbig + Marker [n]) ---
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Sachverhalt');
  doc.moveDown(0.2);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor('#888888')
    .text('Markierte Stellen sind farbig und mit [Nr.] nummeriert — dieselbe Nr. steht in der Tabelle „Markierungen".', { width: contentWidth });
  doc.moveDown(0.3);

  drawAnnotated(doc, model.tokens, { left, right, bottom, fontSize: 10 });
  doc.fillColor('#111111');
  doc.moveDown(1);

  // --- Markierungen (Tabelle) ---
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text('Markierungen');
  doc.moveDown(0.4);

  if (model.markings.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#666666').text('Keine Markierungen.');
    doc.end();
    return done;
  }

  const cols = [
    { title: 'Nr.', w: 0.05 },
    { title: 'Fundstelle (markierter Text)', w: 0.29 },
    { title: 'Begriff · Norm', w: 0.2 },
    { title: 'Herkunft · Status', w: 0.12 },
    { title: 'Governance · Risiko', w: 0.17 },
    { title: 'Notiz · Maßnahme', w: 0.17 },
  ].map((c) => ({ ...c, width: c.w * contentWidth }));
  const xs: number[] = [];
  let acc = left;
  for (const c of cols) { xs.push(acc); acc += c.width; }
  const pad = 4;

  const drawHeader = (y: number): number => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#111111');
    let h = 0;
    cols.forEach((c, i) => {
      h = Math.max(h, doc.heightOfString(c.title, { width: c.width - 2 * pad }));
      doc.text(c.title, xs[i]! + pad, y + pad, { width: c.width - 2 * pad });
    });
    const rowH = h + 2 * pad;
    doc.moveTo(left, y + rowH).lineTo(right, y + rowH).strokeColor('#999999').stroke();
    return y + rowH;
  };

  let y = drawHeader(doc.y);

  for (const m of model.markings) {
    const normJoined = m.normAnker.join(', ');
    const begriffNorm =
      m.begriff +
      (m.streitig ? '  ⚠ streitig' : '') +
      (m.engineStatusLabel ? `\n${m.engineStatusLabel}` : '') +
      (normJoined && normJoined !== m.begriff ? `\nNorm: ${normJoined}` : '');
    const risiko = [m.schadenLabel, m.wahrscheinlichkeitLabel].filter(Boolean).join(' / ');
    const cells = [
      String(m.nr),
      m.fundstelle || '—',
      begriffNorm,
      `${m.herkunftLabel}\n${m.statusLabel}`,
      (m.governanceLabel ?? '—') + (risiko ? `\nRisiko: ${risiko}` : ''),
      [m.notiz, m.kontrolle ? 'Maßnahme: ' + m.kontrolle : null].filter(Boolean).join('\n') || '—',
    ];

    doc.font('Helvetica').fontSize(8);
    const heights = cells.map((t, i) => doc.heightOfString(t, { width: cols[i]!.width - 2 * pad }));
    const rowH = Math.max(...heights) + 2 * pad;

    if (y + rowH > bottom) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
      doc.font('Helvetica').fontSize(8);
    }

    cells.forEach((t, i) => {
      doc.fillColor(i === 0 ? m.herkunftColor : '#222222');
      doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(t, xs[i]! + pad, y + pad, { width: cols[i]!.width - 2 * pad });
    });
    doc.font('Helvetica').fillColor('#222222');
    doc.moveTo(left, y + rowH).lineTo(right, y + rowH).strokeColor('#DDDDDD').stroke();
    y += rowH;
  }

  doc.end();
  return done;
}
