// =============================================================================
// Report-Modell → PDF (pdfkit). Reiner Renderer, hängt nur am ReportModel.
//
// pdfkit ist serverExternalPackages (next.config) — lädt seine Standard-Fonts
// zur Laufzeit aus node_modules, darf nicht gebündelt werden.
// =============================================================================

import PDFDocument from 'pdfkit';
import { DISCLAIMER, type ReportModel } from './report-model';

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function metaLine(model: ReportModel): string {
  return [
    model.clientName ? `Mandant: ${model.clientName}` : null,
    `Erstellt: ${model.createdAt.toLocaleDateString('de-DE')}`,
    `Markierungen: ${model.counts.gesamt} (${model.counts.eigen} eigene)`,
    `Katalog ${model.katalogVersion} · Engine ${model.engineVersion}`,
    model.llmEnriched ? 'KI-vertieft' : null,
    `Hash ${model.textHash.slice(0, 16)}…`,
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

  doc.fontSize(10);
  const toks = model.tokens;
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    const cont = i < toks.length - 1;
    if (tok.kind === 'marker') {
      doc.font('Helvetica-Bold').fillColor(tok.color).text(`[${tok.nr}]`, { width: contentWidth, continued: cont });
      doc.font('Helvetica');
    } else {
      doc.font('Helvetica').fillColor(tok.color ?? '#111111').text(tok.text, { width: contentWidth, continued: cont });
    }
  }
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
